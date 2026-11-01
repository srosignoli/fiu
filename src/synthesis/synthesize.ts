import { generateText, NoObjectGeneratedError, Output, type LanguageModel, type ModelMessage } from 'ai';
import { usageOf, type ModelUsage } from '../cost/usage.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import { describeFailures, verify, type Verification } from '../verify/gate.ts';
import type { ProviderOptions } from './model.ts';
import type { z } from 'zod';
import { drillUserPrompt, MAX_SOURCE_LINES, retryPrompt, seriesRetryPrompt, seriesRules, systemPromptFor, type DrillTarget } from './prompt.ts';
import {
  checkWorkoutOutput,
  expandSeries,
  NOUN,
  outputSchemaFor,
  PredictionSeriesOutputSchema,
  seriesOverlaps,
  AnyWorkoutOutputSchema,
  type AnyWorkoutOutput,
  type PredictionOutput,
  type PredictionSeriesOutput,
  type WorkoutKind,
} from './schema.ts';

/** One generation plus up to two retries, per spec §6. */
export const MAX_ATTEMPTS = 3;

export type SynthesisEvent =
  | { type: 'generating'; attempt: number }
  /** What one LLM call used, reported as soon as it returns, so spend is known even if a later call fails. */
  | { type: 'usage'; attempt: number; usage: ModelUsage[] }
  | { type: 'verifying'; attempt: number }
  | { type: 'rejected'; attempt: number; feedback: string };

export interface SynthesizeDrillOptions {
  target: DrillTarget;
  profile: LanguageProfile;
  sandbox: Sandbox;
  model: LanguageModel;
  /** The model id requested, for attributing usage when the response doesn't name one. */
  modelId: string;
  providerOptions?: ProviderOptions;
  onEvent?: (event: SynthesisEvent) => void;
  /** Root for the profile's persistent caches (tests use a temp dir). */
  cacheRoot?: string;
  /** A Quick Drill: the prompt asks for one, and its size is checked. */
  quick?: boolean;
  /** At most this many attempts (never more than MAX_ATTEMPTS). */
  maxAttempts?: number;
  /** A Drill (find the bug) or a Kata (fill the gap). */
  kind?: WorkoutKind;
}

export type SynthesisResult =
  | { status: 'verified'; workout: AnyWorkoutOutput; verification: Extract<Verification, { verified: true }>; attempts: number }
  | { status: 'not-worth-practicing'; reason: string }
  | { status: 'failed'; feedback: string; attempts: number };

export class SourceTooLargeError extends Error {
  constructor(path: string, lines: number) {
    super(`${path} has ${lines} lines; Kintsugi drills files of up to ${MAX_SOURCE_LINES}. Move the unit you want into a smaller file first.`);
  }
}

/**
 * Generates a Drill and runs it through the Verified gate, feeding every failure back to the model
 * for up to two more attempts. Nothing is returned as verified unless it passed the gate.
 */
export async function synthesizeDrill({
  target,
  profile,
  sandbox,
  model,
  modelId,
  providerOptions,
  onEvent = () => {},
  cacheRoot,
  quick = false,
  maxAttempts = MAX_ATTEMPTS,
  kind = 'drill',
}: SynthesizeDrillOptions): Promise<SynthesisResult> {
  const sourceLines = target.source.replace(/\n$/, '').split('\n').length;
  if (sourceLines > MAX_SOURCE_LINES) throw new SourceTooLargeError(target.path, sourceLines);
  // A Prediction from a commit also sees the file before it, and offers its behaviour as a wrong option.
  const before = kind === 'prediction' ? target.change?.before : undefined;
  const fromCommit = before !== undefined;
  const beforeLines = before?.replace(/\n$/, '').split('\n').length ?? 0;
  if (beforeLines > MAX_SOURCE_LINES) throw new SourceTooLargeError(`${target.path} (before the commit)`, beforeLines);

  // The conversation only ever grows, so each retry sees its own earlier attempts and their feedback.
  const messages: ModelMessage[] = [{ role: 'user', content: drillUserPrompt(target, kind) }];
  let feedback = '';

  const attempts = Math.min(maxAttempts, MAX_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    onEvent({ type: 'generating', attempt });
    const generated = await generate(model, modelId, systemPromptFor(kind, profile, { quick, fromCommit }), outputSchemaFor(kind, { fromCommit }), messages, providerOptions);
    onEvent({ type: 'usage', attempt, usage: generated.usage });
    messages.push(...generated.responseMessages);

    if (generated.output?.worthPracticing === false) {
      return { status: 'not-worth-practicing', reason: generated.output.notWorthReason || 'No reason given.' };
    }

    if (!generated.output) {
      feedback = `[schema] The response was not a valid ${NOUN[kind]} object: ${generated.error}`;
    } else {
      const problems = checkWorkoutOutput(kind, generated.output, sourceLines, { quick, lineComment: profile.lineComment, fromCommit });
      if (problems.length > 0) {
        feedback = problems.map((problem) => `[schema] ${problem}`).join('\n');
      } else {
        onEvent({ type: 'verifying', attempt });
        const verification = await verify(
          {
            kind,
            quick,
            startingCode: generated.output.startingCode,
            referenceSolution: generated.output.referenceSolution,
            testSuiteCode: generated.output.testSuiteCode,
            regressionTestName: generated.output.regressionTestName,
            options: generated.output.options,
            causes: generated.output.causes,
            source: target.source,
            lineComment: profile.lineComment,
            previous: generated.output.previous,
            sourceBefore: before,
          },
          profile,
          sandbox,
          { cacheRoot },
        );
        if (verification.verified) return { status: 'verified', workout: generated.output, verification, attempts: attempt };
        feedback = describeFailures(verification.failures);
      }
    }

    onEvent({ type: 'rejected', attempt, feedback });
    messages.push({ role: 'user', content: retryPrompt(feedback, kind) });
  }
  return { status: 'failed', feedback, attempts };
}

/** A Series gets its first call and one retry for the questions that failed (§11.11). */
export const SERIES_ATTEMPTS = 2;

export type SeriesQuestionResult = { workout: PredictionOutput; verification: Extract<Verification, { verified: true }>; attempt: number };

export type SeriesResult =
  | { status: 'verified'; questions: SeriesQuestionResult[]; requested: number; attempts: number }
  | { status: 'not-worth-practicing'; reason: string }
  | { status: 'failed'; feedback: string; attempts: number };

/**
 * A Series of `count` Predictions about one unit: one call writes the shared Reference Solution and the
 * questions; each question is checked and Verified on its own, and those that pass are kept. One retry
 * asks for replacements of the failed ones only.
 */
export async function synthesizeSeries({
  target,
  profile,
  sandbox,
  model,
  modelId,
  providerOptions,
  onEvent = () => {},
  cacheRoot,
  maxAttempts = SERIES_ATTEMPTS,
  count,
}: Omit<SynthesizeDrillOptions, 'kind' | 'quick'> & { count: number }): Promise<SeriesResult> {
  const sourceLines = target.source.replace(/\n$/, '').split('\n').length;
  if (sourceLines > MAX_SOURCE_LINES) throw new SourceTooLargeError(target.path, sourceLines);
  const system = systemPromptFor('prediction', profile) + seriesRules(count);
  const messages: ModelMessage[] = [{ role: 'user', content: drillUserPrompt(target, 'prediction') }];
  const kept: SeriesQuestionResult[] = [];
  let feedback = '';
  let ran = 0;

  const attempts = Math.min(maxAttempts, SERIES_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    ran = attempt;
    onEvent({ type: 'generating', attempt });
    const generated = await generate<PredictionSeriesOutput>(model, modelId, system, PredictionSeriesOutputSchema, messages, providerOptions);
    onEvent({ type: 'usage', attempt, usage: generated.usage });
    messages.push(...generated.responseMessages);
    const needed = count - kept.length;

    if (generated.output?.worthPracticing === false) {
      if (kept.length > 0) break;
      return { status: 'not-worth-practicing', reason: generated.output.notWorthReason || 'No reason given.' };
    }
    const failures: string[] = [];
    if (!generated.output) {
      failures.push(`[schema] The response was not a valid Series: ${generated.error}`);
    } else {
      const questions = expandSeries(generated.output).slice(0, needed);
      if (questions.length === 0) failures.push(`[schema] questions is empty: write ${needed} question(s).`);
      const overlaps = seriesOverlaps(questions, kept.map((k) => k.workout));
      onEvent({ type: 'verifying', attempt });
      for (const [i, question] of questions.entries()) {
        const label = `Question ${i + 1} ("${question.title}")`;
        const problems = [...checkWorkoutOutput('prediction', question, sourceLines, { lineComment: profile.lineComment }), ...(overlaps.get(i) ?? [])];
        if (problems.length > 0) {
          failures.push(`${label}:\n${problems.map((p) => `[schema] ${p}`).join('\n')}`);
          continue;
        }
        const verification = await verify(
          { kind: 'prediction', referenceSolution: question.referenceSolution, testSuiteCode: question.testSuiteCode, options: question.options, source: target.source, lineComment: profile.lineComment },
          profile,
          sandbox,
          { cacheRoot },
        );
        if (verification.verified) kept.push({ workout: question, verification, attempt });
        else failures.push(`${label}:\n${describeFailures(verification.failures)}`);
      }
      if (questions.length > 0 && questions.length < needed && failures.length === 0) failures.push(`Only ${questions.length} question(s) were written; ${needed} were asked for.`);
    }
    if (kept.length >= count) break;
    feedback = failures.join('\n\n');
    onEvent({ type: 'rejected', attempt, feedback });
    messages.push({ role: 'user', content: seriesRetryPrompt(feedback, kept.length, count - kept.length) });
  }
  if (kept.length > 0) return { status: 'verified', questions: kept, requested: count, attempts: ran };
  return { status: 'failed', feedback, attempts: ran };
}

interface Generated<T = AnyWorkoutOutput> {
  output?: T;
  error?: string;
  responseMessages: ModelMessage[];
  usage: ModelUsage[];
}

async function generate<T = AnyWorkoutOutput>(
  model: LanguageModel,
  modelId: string,
  system: string,
  schema: z.ZodType,
  messages: ModelMessage[],
  providerOptions: ProviderOptions | undefined,
): Promise<Generated<T>> {
  try {
    const result = await generateText({
      model,
      system,
      messages,
      // Each kind's schema is a subset of AnyWorkoutOutputSchema's shape, so its output is one too.
      output: Output.object({ schema: schema as unknown as typeof AnyWorkoutOutputSchema }),
      providerOptions,
      maxOutputTokens: 32_000,
    });
    return { output: result.output as T, responseMessages: result.response.messages, usage: usageOf(result, modelId) };
  } catch (error) {
    // A malformed object is worth a retry; anything else (auth, network, quota) is not.
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    return {
      error: String(error.cause ?? error.message),
      // Keep the model's answer in the conversation so the retry can see what it got wrong.
      responseMessages: error.text ? [{ role: 'assistant', content: error.text }] : [],
      // A malformed answer is still billed.
      usage: usageOf({ usage: error.usage, response: error.response }, modelId),
    };
  }
}
