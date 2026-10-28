import { generateText, NoObjectGeneratedError, Output, type LanguageModel, type ModelMessage } from 'ai';
import { usageOf, type ModelUsage } from '../cost/usage.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import { describeFailures, verify, type Verification } from '../verify/gate.ts';
import type { ProviderOptions } from './model.ts';
import { drillUserPrompt, MAX_SOURCE_LINES, retryPrompt, systemPromptFor, type DrillTarget } from './prompt.ts';
import { checkWorkoutOutput, outputSchemaFor, AnyWorkoutOutputSchema, type AnyWorkoutOutput, type WorkoutKind } from './schema.ts';

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

  // The conversation only ever grows, so each retry sees its own earlier attempts and their feedback.
  const messages: ModelMessage[] = [{ role: 'user', content: drillUserPrompt(target, kind) }];
  let feedback = '';

  const attempts = Math.min(maxAttempts, MAX_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    onEvent({ type: 'generating', attempt });
    const generated = await generate(model, modelId, profile, messages, providerOptions, quick, kind);
    onEvent({ type: 'usage', attempt, usage: generated.usage });
    messages.push(...generated.responseMessages);

    if (generated.output?.worthPracticing === false) {
      return { status: 'not-worth-practicing', reason: generated.output.notWorthReason || 'No reason given.' };
    }

    if (!generated.output) {
      feedback = `[schema] The response was not a valid ${kind === 'drill' ? 'Drill' : 'Kata'} object: ${generated.error}`;
    } else {
      const problems = checkWorkoutOutput(kind, generated.output, sourceLines, { quick });
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

interface Generated {
  output?: AnyWorkoutOutput;
  error?: string;
  responseMessages: ModelMessage[];
  usage: ModelUsage[];
}

async function generate(
  model: LanguageModel,
  modelId: string,
  profile: LanguageProfile,
  messages: ModelMessage[],
  providerOptions: ProviderOptions | undefined,
  quick: boolean,
  kind: WorkoutKind,
): Promise<Generated> {
  try {
    const result = await generateText({
      model,
      system: systemPromptFor(kind, profile, { quick }),
      messages,
      // Each kind's schema is a subset of AnyWorkoutOutputSchema's shape, so its output is one too.
      output: Output.object({ schema: outputSchemaFor(kind) as unknown as typeof AnyWorkoutOutputSchema }),
      providerOptions,
      maxOutputTokens: 32_000,
    });
    return { output: result.output, responseMessages: result.response.messages, usage: usageOf(result, modelId) };
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
