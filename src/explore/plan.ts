import { generateText, NoObjectGeneratedError, Output, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import { usageOf, type ModelUsage } from '../cost/usage.ts';
import type { ProviderOptions } from '../synthesis/model.ts';
import type { Candidate } from './shortlist.ts';

export const MIN_STEPS = 3;
export const MAX_STEPS = 5;
export const MAX_ALTERNATES = 3;

const StepSchema = z.object({
  path: z.string().describe('One of the candidate paths, exactly as listed.'),
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

/** The rules for ordering a Track: shared by Kintsugi's own planning call and agent mode's prepare_track. */
export const TRACK_RULES = `You design Tracks: short learning paths that teach a newcomer one module of a codebase through a few debugging Drills, one per file.

From the candidate files of the module, choose ${MIN_STEPS} to ${MAX_STEPS} steps, each a different file, and order them foundations first: a file the others build on (its types, its core data structure, its central algorithm) comes before the files that use or orchestrate it. Prefer files whose logic a newcomer most needs to understand; skip thin wrappers and glue.

For each step, give its pillar (algorithm: data transformation or state logic; pattern: how components are wired together; library: a runtime or library mechanism the module relies on) and one line saying why understanding it matters for the module. The line is shown before the newcomer solves anything, so it describes the code's role, never a bug.

Also list up to ${MAX_ALTERNATES} alternates, best first, in case a step can't be made into a Drill.`;

export function candidatesPrompt(modulePath: string, candidates: Candidate[]): string {
  const listed = candidates
    .map((c) => [`- ${c.path} (${c.lines} lines)`, ...c.outline.map((line) => `    ${line}`)].join('\n'))
    .join('\n');
  return `Module: ${modulePath || '(repository root)'}\n\nCandidate files, with their declarations:\n${listed}`;
}

/** The plan's problems against the shortlist; empty when it can be used. */
export function checkPlan(plan: TrackPlan, candidates: Candidate[]): string[] {
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
  }
  return problems;
}

export interface PlanTrackOptions {
  modulePath: string;
  candidates: Candidate[];
  model: LanguageModel;
  modelId: string;
  providerOptions?: ProviderOptions;
}

export type PlanResult = { plan?: TrackPlan; problems: string[]; usage: ModelUsage[] };

/** One inexpensive call (plus one retry on an unusable answer) that picks and orders the Track's steps. */
export async function planTrack({ modulePath, candidates, model, modelId, providerOptions }: PlanTrackOptions): Promise<PlanResult> {
  const messages: ModelMessage[] = [{ role: 'user', content: candidatesPrompt(modulePath, candidates) }];
  const usage: ModelUsage[] = [];
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await generateText({
        model,
        system: TRACK_RULES,
        messages,
        output: Output.object({ schema: TrackPlanSchema }),
        providerOptions,
        maxOutputTokens: 4_000,
      });
      usage.push(...usageOf(result, modelId));
      problems = checkPlan(result.output, candidates);
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
