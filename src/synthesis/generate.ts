import { resolve } from 'node:path';
import type { ResolvedConfig } from '../config.ts';
import { estimateCost, formatUsd, type Cost, type ModelUsage } from '../cost/usage.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import { saveDrill, type Origin, type SourceRevision, type WorkoutRecord } from '../workouts/save.ts';
import { averageSpend, readState, recordSpend, type Spend } from '../workouts/store.ts';
import type { WorkspacePaths } from '../workspace.ts';
import type { createModel } from './model.ts';
import type { DrillTarget } from './prompt.ts';
import { MAX_ATTEMPTS, synthesizeDrill, type SynthesisEvent } from './synthesize.ts';

export type GenerationResult =
  | { status: 'saved'; record: WorkoutRecord; workoutDir: string; testCmd: string; attempts: number; cost: Cost }
  | { status: 'not-worth-practicing'; reason: string; cost: Cost }
  | { status: 'failed'; feedback: string; cost: Cost };

export interface GenerateOptions {
  paths: WorkspacePaths;
  config: ResolvedConfig;
  profile: LanguageProfile;
  sandbox: Sandbox;
  apiKey: string;
  createModel: typeof createModel;
  target: DrillTarget;
  revision: SourceRevision;
  quick: boolean;
  origin: Origin;
  /** The commit a background Drill was generated from. */
  commit?: { sha: string; aiAuthored: boolean };
  /** Fewer than the usual attempts when a daily limit has fewer left. */
  maxAttempts?: number;
  cacheRoot?: string;
  step: (message: string) => void;
}

/**
 * Kintsugi's own generation, shared by `kin drill` and `kin refill`: generate, verify, and save a
 * Drill, recording everything it cost in the spend ledger whatever the outcome.
 */
export async function generateWorkout(options: GenerateOptions): Promise<GenerationResult> {
  const { paths, config, profile, sandbox, target, step } = options;
  const average = averageSpend((await readState(paths)).spend);
  if (average) step(`Your Drills have averaged ${formatUsd(average.usd)} (last ${average.count})`);

  const { model, providerOptions } = options.createModel(config.provider, config.model, options.apiKey);
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const usage: ModelUsage[] = [];
  const spend: Pick<Spend, 'result' | 'workoutId' | 'generationAttempts'> = { result: 'error', generationAttempts: 0 };
  try {
    const result = await synthesizeDrill({
      quick: options.quick,
      maxAttempts,
      target,
      profile,
      sandbox,
      model,
      modelId: config.model,
      providerOptions,
      cacheRoot: options.cacheRoot,
      onEvent: (event) => {
        if (event.type === 'usage') {
          usage.push(...event.usage);
          spend.generationAttempts = event.attempt;
        } else {
          step(describeEvent(event, maxAttempts));
        }
      },
    });
    const cost = estimateCost(usage, config.prices);

    if (result.status === 'not-worth-practicing') {
      spend.result = 'not-worth-practicing';
      return { ...result, cost };
    }
    if (result.status === 'failed') {
      spend.result = 'not-verified';
      return { status: 'failed', feedback: result.feedback, cost };
    }

    const record = await saveDrill({
      paths,
      profile,
      drill: result.drill,
      sourcePath: target.path,
      symbol: target.symbol,
      revision: options.revision,
      cost,
      generationAttempts: result.attempts,
      origin: options.origin,
      commit: options.commit,
    });
    Object.assign(spend, { result: 'verified', workoutId: record.id });
    const workoutDir = resolve(paths.workoutsDir, record.id);
    return { status: 'saved', record, workoutDir, testCmd: profile.testCmd, attempts: result.attempts, cost };
  } finally {
    // Everything the model was paid for lands in the ledger, even when generation failed midway.
    if (usage.length > 0) {
      await recordSpend(paths, {
        at: new Date().toISOString(),
        origin: options.origin,
        generator: 'kintsugi',
        source: target.path,
        ...spend,
        cost: estimateCost(usage, config.prices),
      });
    }
  }
}

function describeEvent(event: Exclude<SynthesisEvent, { type: 'usage' }>, maxAttempts: number): string {
  const of = `(attempt ${event.attempt} of ${maxAttempts})`;
  switch (event.type) {
    case 'generating':
      return `Generating the Drill ${of}`;
    case 'verifying':
      return `Verifying it in the sandbox ${of}`;
    case 'rejected':
      return `Not Verified, retrying with feedback:\n${event.feedback}`;
  }
}
