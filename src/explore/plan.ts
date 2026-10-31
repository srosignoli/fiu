import { generateText, NoObjectGeneratedError, Output, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import { usageOf, type ModelUsage } from '../cost/usage.ts';
import type { ProviderOptions } from '../synthesis/model.ts';
import type { Atlas } from '../atlas/store.ts';
import type { Candidate } from './shortlist.ts';
import { NOUN, type WorkoutKind } from '../synthesis/schema.ts';
import type { PreferredKind } from '../config.ts';

/**
 * The kinds a Track may use: those given (`kin explore --kinds`), else Predictions only for someone whose
 * \`kinds\` setting lists only Predictions (they don't read code), else all three.
 */
export function trackKinds(preferred: readonly PreferredKind[], override?: readonly WorkoutKind[]): WorkoutKind[] {
  if (override && override.length > 0) return TRACK_KINDS.filter((k) => override.includes(k));
  return preferred.length > 0 && preferred.every((k) => k === 'prediction') ? ['prediction'] : [...TRACK_KINDS];
}

export const MIN_STEPS = 3;
export const MAX_STEPS = 5;
export const MAX_ALTERNATES = 3;

const StepSchema = z.object({
  path: z.string().describe('One of the candidate paths, exactly as listed.'),
  kind: z.enum(['prediction', 'drill', 'kata']).describe('How this step is practised: one of the allowed kinds.'),
  pillar: z.enum(['algorithm', 'pattern', 'library']),
  why: z.string().describe('One line: why understanding this file matters for the module.'),
});

export const TrackPlanSchema = z.object({
  title: z.string().describe('A short title for the Track, naming what the module does.'),
  steps: z.array(StepSchema).describe(`${MIN_STEPS} to ${MAX_STEPS} steps, foundations first.`),
  alternates: z.array(StepSchema).describe(`Up to ${MAX_ALTERNATES} further candidates, best first, used if a step can't be made into a Drill.`),
});
export type TrackPlan = z.infer<typeof TrackPlanSchema>;
export type PlannedStep = z.infer<typeof StepSchema>;

/** Every kind a Track step can be, in the order a Track usually uses them. */
export const TRACK_KINDS: WorkoutKind[] = ['prediction', 'drill', 'kata'];

const KIND_LINES: Record<WorkoutKind, string> = {
  prediction: 'prediction: a plain-English Scenario about what the file does, with four outcomes to choose from, no code to read. Good for opening a Track: what the module does before how.',
  drill: 'drill: a realistic bug injected into the file, to find and fix. Good for the foundations: the core data structures and algorithms.',
  kata: 'kata: one piece of the file removed, to rebuild from a brief. Good for closing a Track: the file that ties the module together.',
};

/**
 * The rules for ordering a Track: shared by Kintsugi's own planning call and agent mode's prepare_track.
 * `kinds` are the kinds this Track may use (§11.11).
 */
export function trackRules(kinds: readonly WorkoutKind[] = TRACK_KINDS): string {
  const mix =
    kinds.length > 1
      ? `Use at least two different kinds across the steps. A good arc opens with a Prediction, puts Drills on the foundations, and closes with a Kata, when those kinds are allowed and the files suit them.`
      : `Every step is a ${NOUN[kinds[0]!]}.`;
  return `You design Tracks: short learning paths that teach a newcomer one module of a codebase through a few exercises, one per file.

From the candidate files of the module, choose ${MIN_STEPS} to ${MAX_STEPS} steps, each a different file, and order them foundations first: a file the others build on (its types, its core data structure, its central algorithm) comes before the files that use or orchestrate it. Prefer files whose logic a newcomer most needs to understand; skip thin wrappers and glue.

For each step, choose its kind, how it is practised. The allowed kinds:
${kinds.map((kind) => `- ${KIND_LINES[kind]}`).join('\n')}
${mix}

Give each step its pillar (algorithm: data transformation or state logic; pattern: how components are wired together; library: a runtime or library mechanism the module relies on) and one line saying why understanding it matters for the module. The line is shown before the newcomer starts, so it describes the code's role, never a bug or an answer.

Also list up to ${MAX_ALTERNATES} alternates, best first, in case a step can't be made: an alternate takes the kind of the step it replaces.`;
}

export function candidatesPrompt(modulePath: string, candidates: Candidate[]): string {
  const listed = candidates
    .map((c) => [`- ${c.path} (${c.lines} lines)`, ...(c.atlas ? c.atlas.split('\n') : c.outline).map((line) => `    ${line}`)].join('\n'))
    .join('\n');
  const what = candidates.some((c) => c.atlas) ? 'what each is for (from the Atlas) or its declarations' : 'their declarations';
  return `Module: ${modulePath || '(repository root)'}\n\nCandidate files, with ${what}:\n${listed}`;
}

/** Candidates with what the Atlas says each file and its key functions are for, where it says anything. */
export function withAtlas(candidates: Candidate[], atlas: Atlas): Candidate[] {
  return candidates.map((c) => {
    const entry = atlas.files[c.path];
    if (!entry) return c;
    const functions = Object.entries(entry.functions).map(([name, text]) => `${name}: ${text}`);
    return { ...c, atlas: [entry.text.replace(/\n/g, ' '), ...functions].join('\n') };
  });
}

/** The plan's problems against the shortlist and the allowed kinds; empty when it can be used. */
export function checkPlan(plan: TrackPlan, candidates: Candidate[], kinds: readonly WorkoutKind[] = TRACK_KINDS): string[] {
  const known = new Set(candidates.map((c) => c.path));
  const problems: string[] = [];
  if (plan.title.trim() === '') problems.push('title is empty.');
  if (plan.steps.length < MIN_STEPS || plan.steps.length > MAX_STEPS) problems.push(`choose ${MIN_STEPS} to ${MAX_STEPS} steps, not ${plan.steps.length}.`);
  if (plan.alternates.length > MAX_ALTERNATES) problems.push(`list at most ${MAX_ALTERNATES} alternates.`);
  const seen = new Set<string>();
  for (const step of [...plan.steps, ...plan.alternates]) {
    if (!known.has(step.path)) problems.push(`${step.path} is not one of the candidate files.`);
    if (seen.has(step.path)) problems.push(`${step.path} appears more than once: each step is a different file.`);
    seen.add(step.path);
    if (step.why.trim() === '') problems.push(`the why line for ${step.path} is empty.`);
    if (!kinds.includes(step.kind)) problems.push(`${step.path} is a ${step.kind}, which this Track doesn't allow: use ${kinds.join(', ')}.`);
  }
  const used = new Set(plan.steps.map((s) => s.kind));
  if (kinds.length > 1 && plan.steps.length >= MIN_STEPS && used.size < 2) problems.push(`every step is a ${[...used][0]}: use at least two kinds of ${kinds.join(', ')}.`);
  return problems;
}

export interface PlanTrackOptions {
  modulePath: string;
  /** The kinds the Track may use. */
  kinds?: readonly WorkoutKind[];
  candidates: Candidate[];
  model: LanguageModel;
  modelId: string;
  providerOptions?: ProviderOptions;
}

export type PlanResult = { plan?: TrackPlan; problems: string[]; usage: ModelUsage[] };

/** One inexpensive call (plus one retry on an unusable answer) that picks and orders the Track's steps. */
export async function planTrack({ modulePath, kinds = TRACK_KINDS, candidates, model, modelId, providerOptions }: PlanTrackOptions): Promise<PlanResult> {
  const messages: ModelMessage[] = [{ role: 'user', content: candidatesPrompt(modulePath, candidates) }];
  const usage: ModelUsage[] = [];
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await generateText({
        model,
        system: trackRules(kinds),
        messages,
        output: Output.object({ schema: TrackPlanSchema }),
        providerOptions,
        maxOutputTokens: 4_000,
      });
      usage.push(...usageOf(result, modelId));
      problems = checkPlan(result.output, candidates, kinds);
      if (problems.length === 0) return { plan: result.output, problems, usage };
      messages.push(...result.response.messages);
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw error;
      usage.push(...usageOf({ usage: error.usage, response: error.response }, modelId));
      problems = [`the answer was not a valid plan: ${String(error.cause ?? error.message)}`];
    }
    messages.push({ role: 'user', content: `That plan can't be used:\n${problems.map((p) => `- ${p}`).join('\n')}\nGive a corrected plan.` });
  }
  return { problems, usage };
}
