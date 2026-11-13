import { posix } from 'node:path';
import { readAtlasOverlay } from '../atlas/overlay.ts';
import { words } from '../atlas/search.ts';
import type { Skeleton } from '../atlas/skeleton.ts';
import type { ForeignFlow } from '../atlas/ua.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import type { WorkspacePaths } from '../workspace.ts';
import { MIN_STEPS } from './plan.ts';
import { candidateFor, ExploreTargetError, type Candidate } from './shortlist.ts';

/**
 * Tracks that follow a business flow from Understand-Anything's domain graph (ADR 0010): the flow's
 * files, in the order the flow reaches them, instead of a module's files ordered foundations first.
 * The flow is UA's reading of the code; every step of the Track is still a Workout, and Verified.
 */

/** The flow's files as Track candidates, in the order the flow first reaches each, each with the steps it runs. */
export async function flowCandidates(repoRoot: string, flow: ForeignFlow, profiles: readonly LanguageProfile[]): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const path of [...new Set(flow.steps.flatMap((step) => (step.path ? [step.path] : [])))]) {
    const candidate = await candidateFor(repoRoot, path, profiles);
    if (!candidate) continue;
    const steps = flow.steps.flatMap((step, i) => (step.path === path ? [`step ${i + 1} of ${flow.steps.length}: ${step.name}`] : []));
    candidates.push({ ...candidate, flowSteps: steps.join('; ') });
  }
  return candidates;
}

/** The flows in the repository's domain graph, or why there are none. */
export async function readFlows(paths: WorkspacePaths, skeleton: Skeleton): Promise<ForeignFlow[]> {
  const { ua } = await readAtlasOverlay(paths, skeleton);
  if (ua.status === 'off') throw new ExploreTargetError('Understand-Anything is turned off for this repository ("understandAnything": false in .fiu/config.json): explore a module instead.');
  if (ua.status !== 'read' || ua.atlas.flows.length === 0) {
    throw new ExploreTargetError("This repository has no Understand-Anything flows: run /understand and then /understand-domain in Claude Code (they write .ua/domain-graph.json), or explore a module instead.");
  }
  return ua.atlas.flows;
}

/** Each flow with how many of its files could be a Track step, best candidates first. */
export async function trackableFlows(repoRoot: string, flows: ForeignFlow[], profiles: readonly LanguageProfile[]): Promise<{ flow: ForeignFlow; files: number }[]> {
  const listed = await Promise.all(flows.map(async (flow) => ({ flow, files: (await flowCandidates(repoRoot, flow, profiles)).length })));
  return listed.sort((a, b) => Number(b.files >= MIN_STEPS) - Number(a.files >= MIN_STEPS) || b.files - a.files || a.flow.name.localeCompare(b.flow.name));
}

/**
 * The flow a name means: the same name ignoring case, else the one flow whose name holds every word of
 * it ("refill" finds "Refill the Queue from a Commit"). None, or several, is an error naming the flows.
 */
export function findFlow(flows: ForeignFlow[], name: string): ForeignFlow {
  const wanted = name.trim().toLowerCase();
  const exact = flows.find((flow) => flow.name.toLowerCase() === wanted);
  if (exact) return exact;
  const goal = words(name);
  const matching = goal.length === 0 ? [] : flows.filter((flow) => goal.every((word) => words(`${flow.name} ${flow.domain ?? ''}`).some((w) => w.startsWith(word) || word.startsWith(w))));
  if (matching.length === 1) return matching[0]!;
  const listed = (matching.length > 1 ? matching : flows).map((flow) => `- ${flow.name}`).join('\n');
  throw new ExploreTargetError(
    matching.length > 1 ? `"${name}" matches several flows; name one:\n${listed}` : `No flow matches "${name}". The flows are:\n${listed}\n(\`fiu explore --flow\` lists them with how many files each could use.)`,
  );
}

/** The folder the Track's files share: its `module`, for where Tracks are listed and named. */
export function flowModule(paths: string[]): string {
  const folders = paths.map((path) => (posix.dirname(path) === '.' ? [] : posix.dirname(path).split('/')));
  const shared: string[] = [];
  for (let i = 0; folders.every((f) => f[i] !== undefined && f[i] === folders[0]![i]); i++) shared.push(folders[0]![i]!);
  return shared.join('/');
}
