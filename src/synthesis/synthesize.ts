import { generateText, NoObjectGeneratedError, Output, type LanguageModel, type ModelMessage } from 'ai';
import type { LanguageProfile } from '../languages/profile.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import { describeFailures, verify, type Verification } from '../verify/gate.ts';
import type { ProviderOptions } from './model.ts';
import { drillSystemPrompt, drillUserPrompt, MAX_SOURCE_LINES, retryPrompt, type DrillTarget } from './prompt.ts';
import { checkDrillOutput, DrillOutputSchema, type DrillOutput } from './schema.ts';

/** One generation plus up to two retries, per spec §6. */
export const MAX_ATTEMPTS = 3;

export type SynthesisEvent =
  | { type: 'generating'; attempt: number }
  | { type: 'verifying'; attempt: number }
  | { type: 'rejected'; attempt: number; feedback: string };

export interface SynthesizeDrillOptions {
  target: DrillTarget;
  profile: LanguageProfile;
  sandbox: Sandbox;
  model: LanguageModel;
  providerOptions?: ProviderOptions;
  onEvent?: (event: SynthesisEvent) => void;
  /** Root for the profile's persistent caches (tests use a temp dir). */
  cacheRoot?: string;
}

export type SynthesisResult =
  | { status: 'verified'; drill: DrillOutput; verification: Extract<Verification, { verified: true }>; attempts: number }
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
  providerOptions,
  onEvent = () => {},
  cacheRoot,
}: SynthesizeDrillOptions): Promise<SynthesisResult> {
  const sourceLines = target.source.replace(/\n$/, '').split('\n').length;
  if (sourceLines > MAX_SOURCE_LINES) throw new SourceTooLargeError(target.path, sourceLines);

  // The conversation only ever grows, so each retry sees its own earlier attempts and their feedback.
  const messages: ModelMessage[] = [{ role: 'user', content: drillUserPrompt(target) }];
  let feedback = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onEvent({ type: 'generating', attempt });
    const generated = await generate(model, profile, messages, providerOptions);
    messages.push(...generated.responseMessages);

    if (generated.output?.worthPracticing === false) {
      return { status: 'not-worth-practicing', reason: generated.output.notWorthReason || 'No reason given.' };
    }

    if (!generated.output) {
      feedback = `[schema] The response was not a valid Drill object: ${generated.error}`;
    } else {
      const problems = checkDrillOutput(generated.output, sourceLines);
      if (problems.length > 0) {
        feedback = problems.map((problem) => `[schema] ${problem}`).join('\n');
      } else {
        onEvent({ type: 'verifying', attempt });
        const verification = await verify(
          {
            kind: 'drill',
            startingCode: generated.output.startingCode,
            referenceSolution: generated.output.referenceSolution,
            testSuiteCode: generated.output.testSuiteCode,
            regressionTestName: generated.output.regressionTestName,
          },
          profile,
          sandbox,
          { cacheRoot },
        );
        if (verification.verified) return { status: 'verified', drill: generated.output, verification, attempts: attempt };
        feedback = describeFailures(verification.failures);
      }
    }

    onEvent({ type: 'rejected', attempt, feedback });
    messages.push({ role: 'user', content: retryPrompt(feedback) });
  }
  return { status: 'failed', feedback, attempts: MAX_ATTEMPTS };
}

interface Generated {
  output?: DrillOutput;
  error?: string;
  responseMessages: ModelMessage[];
}

async function generate(
  model: LanguageModel,
  profile: LanguageProfile,
  messages: ModelMessage[],
  providerOptions: ProviderOptions | undefined,
): Promise<Generated> {
  try {
    const result = await generateText({
      model,
      system: drillSystemPrompt(profile),
      messages,
      output: Output.object({ schema: DrillOutputSchema }),
      providerOptions,
      maxOutputTokens: 32_000,
    });
    return { output: result.output, responseMessages: result.response.messages };
  } catch (error) {
    // A malformed object is worth a retry; anything else (auth, network, quota) is not.
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    return {
      error: String(error.cause ?? error.message),
      // Keep the model's answer in the conversation so the retry can see what it got wrong.
      responseMessages: error.text ? [{ role: 'assistant', content: error.text }] : [],
    };
  }
}
