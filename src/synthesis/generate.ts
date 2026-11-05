import { resolve } from 'node:path';
import type { ResolvedConfig } from '../config.ts';
import { estimateCost, formatUsd, type Cost, type ModelUsage } from '../cost/usage.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import type { LanguageModel } from 'ai';
import { newSeriesId, saveDrill, type Origin, type SourceRevision, type TrackPlacement, type WorkoutRecord } from '../workouts/save.ts';
import { averageSpend, readState, recordSpend, type Spend } from '../workouts/store.ts';
import type { WorkspacePaths } from '../workspace.ts';
import type { createModel, ProviderOptions } from './model.ts';
import type { DrillTarget } from './prompt.ts';
import { NOUN, type WorkoutKind } from './schema.ts';
import { MAX_ATTEMPTS, SERIES_ATTEMPTS, synthesizeDrill, synthesizeSeries, type SynthesisEvent } from './synthesize.ts';

export type GenerationResult =
  | {
      status: 'saved';
      /** The Workout, or a Series' first question. */
      record: WorkoutRecord;
      workoutDir: string;
      testCmd: string;
      attempts: number;
      cost: Cost;
      /** For a Prediction Series: every question saved, and how many were asked for. */
      series?: { id: string; records: WorkoutRecord[]; requested: number };
    }
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
  /** A Drill unless asked for a Kata. */
  kind?: WorkoutKind;
  origin: Origin;
  /** The commit a background Drill was generated from. */
  commit?: { sha: string; aiAuthored: boolean; subject?: string };
  /** For a Track step: its placement, recorded on the Workout. */
  track?: TrackPlacement;
  /** For a Prediction not from a commit: more than 1 makes a Series of this many questions (§11.11). */
  questions?: number;
  /** Fewer than the usual attempts when a daily limit has fewer left. */
  maxAttempts?: number;
  cacheRoot?: string;
  step: (message: string) => void;
}

/**
 * Fiutsu's own generation, shared by `fiu drill` and `fiu refill`: generate, verify, and save a
 * Drill or Kata, recording everything it cost in the spend ledger whatever the outcome.
 */
export async function generateWorkout(options: GenerateOptions): Promise<GenerationResult> {
  const { paths, config, profile, sandbox, target, step } = options;
  const average = averageSpend((await readState(paths)).spend);
  if (average) step(`Your Drills have averaged ${formatUsd(average.usd)} (last ${average.count})`);

  const { model, providerOptions } = options.createModel(config.provider, config.model, options.apiKey);
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const usage: ModelUsage[] = [];
  const spend: Pick<Spend, 'result' | 'workoutId' | 'workoutIds' | 'generationAttempts'> = { result: 'error', generationAttempts: 0 };
  try {
    if (options.kind === 'prediction' && (options.questions ?? 1) > 1 && target.change === undefined && target.whatIf === undefined) {
      return await generateSeries(options, { model, providerOptions, maxAttempts, usage, spend });
    }
    const result = await synthesizeDrill({
      quick: options.quick,
      kind: options.kind,
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
          step(describeEvent(event, maxAttempts, options.kind ?? 'drill'));
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
      drill: result.workout,
      kind: options.kind,
      sourcePath: target.path,
      symbol: target.symbol,
      source: target.source,
      revision: options.revision,
      cost,
      generationAttempts: result.attempts,
      origin: options.origin,
      commit: options.commit,
      track: options.track,
      ...(target.whatIf ? { whatIf: { ...target.whatIf, modelled: result.workout.modelledAs ?? '' } } : {}),
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
        generator: 'fiutsu',
        source: target.path,
        ...spend,
        cost: estimateCost(usage, config.prices),
      });
    }
  }
}

/** A Prediction Series: each Verified question saved as its own Workout, linked by the Series id. */
async function generateSeries(
  options: GenerateOptions,
  run: { model: LanguageModel; providerOptions: ProviderOptions; maxAttempts: number; usage: ModelUsage[]; spend: Pick<Spend, 'result' | 'workoutId' | 'workoutIds' | 'generationAttempts'> },
): Promise<GenerationResult> {
  const { paths, config, profile, sandbox, target, step } = options;
  const count = options.questions!;
  const attempts = Math.min(run.maxAttempts, SERIES_ATTEMPTS);
  const result = await synthesizeSeries({
    count,
    maxAttempts: attempts,
    target,
    profile,
    sandbox,
    model: run.model,
    modelId: config.model,
    providerOptions: run.providerOptions,
    cacheRoot: options.cacheRoot,
    onEvent: (event) => {
      if (event.type === 'usage') {
        run.usage.push(...event.usage);
        run.spend.generationAttempts = event.attempt;
      } else {
        step(event.type === 'generating' ? `Generating a Series of ${count} Predictions (attempt ${event.attempt} of ${attempts})` : describeEvent(event, attempts, 'prediction'));
      }
    },
  });
  const cost = estimateCost(run.usage, config.prices);
  if (result.status === 'not-worth-practicing') {
    run.spend.result = 'not-worth-practicing';
    return { ...result, cost };
  }
  if (result.status === 'failed') {
    run.spend.result = 'not-verified';
    return { status: 'failed', feedback: result.feedback, cost };
  }

  const id = await newSeriesId(paths, result.questions[0]!.workout.slug);
  const records: WorkoutRecord[] = [];
  for (const [i, question] of result.questions.entries()) {
    records.push(
      await saveDrill({
        paths,
        profile,
        drill: question.workout,
        kind: 'prediction',
        sourcePath: target.path,
        symbol: target.symbol,
        source: target.source,
        revision: options.revision,
        // The Series' cost is shared: each question records its share.
        cost: { ...cost, usd: cost.usd / result.questions.length, usage: [] },
        generationAttempts: result.attempts,
        origin: options.origin,
        series: { id, index: i + 1, of: result.questions.length },
      }),
    );
  }
  Object.assign(run.spend, { result: 'verified', workoutId: records[0]!.id, workoutIds: records.map((r) => r.id) });
  return {
    status: 'saved',
    record: records[0]!,
    workoutDir: resolve(paths.workoutsDir, records[0]!.id),
    testCmd: profile.testCmd,
    attempts: result.attempts,
    cost,
    series: { id, records, requested: count },
  };
}

function describeEvent(event: Exclude<SynthesisEvent, { type: 'usage' }>, maxAttempts: number, kind: WorkoutKind): string {
  const of = `(attempt ${event.attempt} of ${maxAttempts})`;
  switch (event.type) {
    case 'generating':
      return `Generating the ${NOUN[kind]} ${of}`;
    case 'verifying':
      return `Verifying it in the sandbox ${of}`;
    case 'rejected':
      return `Not Verified, retrying with feedback:\n${event.feedback}`;
  }
}
