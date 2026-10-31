import { dirname } from 'node:path';
import { listAttemptRecords, type Confidence } from '../workouts/attempts.ts';
import { listWorkouts } from '../workouts/store.ts';
import { findRepoRoot, workspacePaths, type WorkspacePaths } from '../workspace.ts';

/** What each level of confidence should hit, if the human's sense of their own picture is right. */
export const EXPECTED_RATE: Record<Confidence, number> = { guessing: 0.25, 'fairly-sure': 0.7, certain: 0.95 };
export const CONFIDENCE_LEVELS: Confidence[] = ['guessing', 'fairly-sure', 'certain'];
/** A rate on fewer answers than this is noise, and isn't shown. */
export const MIN_ANSWERS = 3;
/** "Recently", for the trend. */
export const RECENT_DAYS = 30;

/** The first finished Attempt at a Prediction: a retry already knows the answer. */
export interface FirstAnswer {
  workoutId: string;
  path: string;
  at: string;
  right: boolean;
  confidence?: Confidence;
}

export interface Tally {
  answers: number;
  right: number;
}

export interface PredictionStats {
  scope: string;
  overall: Tally;
  calibration: (Tally & { confidence: Confidence; expected: number })[];
  /** The last RECENT_DAYS days against everything before. */
  trend: { recent: Tally; before: Tally };
  /** By directory, lowest accuracy first. */
  byDirectory: (Tally & { path: string })[];
  blindSpots: BlindSpot[];
}

/** A file whose most recent first answer was certain and wrong. */
export interface BlindSpot {
  path: string;
  workoutId: string;
  at: string;
}

/** The first answer to every Prediction, oldest first. */
export async function firstAnswers(paths: WorkspacePaths): Promise<FirstAnswer[]> {
  const answers: FirstAnswer[] = [];
  for (const { record } of await listWorkouts(paths)) {
    if (record.kind !== 'prediction') continue;
    const first = (await listAttemptRecords(paths, record.id)).find((a) => a.outcome && a.finishedAt);
    if (!first) continue;
    answers.push({
      workoutId: record.id,
      path: record.source.path,
      at: first.finishedAt!,
      right: first.outcome === 'completed',
      ...(first.confidence ? { confidence: first.confidence } : {}),
    });
  }
  return answers.sort((a, b) => a.at.localeCompare(b.at));
}

/** Files whose latest first answer was certain and wrong; a later right answer clears one. */
export function blindSpots(answers: FirstAnswer[]): BlindSpot[] {
  const latest = new Map<string, FirstAnswer>();
  for (const answer of answers) latest.set(answer.path, answer);
  return [...latest.values()]
    .filter((a) => a.confidence === 'certain' && !a.right)
    .map(({ path, workoutId, at }) => ({ path, workoutId, at }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

const tally = (answers: FirstAnswer[]): Tally => ({ answers: answers.length, right: answers.filter((a) => a.right).length });

/** `kin stats [<path>]`: how often the human's Predictions are right, how well their confidence matches, and their Blind Spots. */
export async function predictionStats(cwd: string, scope = '', now = new Date()): Promise<PredictionStats> {
  const paths = workspacePaths(await findRepoRoot(cwd));
  const inScope = (path: string) => scope === '' || path === scope || path.startsWith(`${scope}/`);
  const answers = (await firstAnswers(paths)).filter((a) => inScope(a.path));
  const since = new Date(now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const byDirectory = new Map<string, FirstAnswer[]>();
  for (const answer of answers) {
    const dir = dirname(answer.path) === '.' ? '' : dirname(answer.path);
    byDirectory.set(dir, [...(byDirectory.get(dir) ?? []), answer]);
  }
  const rate = (t: Tally) => (t.answers === 0 ? 1 : t.right / t.answers);
  return {
    scope,
    overall: tally(answers),
    calibration: CONFIDENCE_LEVELS.map((confidence) => ({ confidence, expected: EXPECTED_RATE[confidence], ...tally(answers.filter((a) => a.confidence === confidence)) })),
    trend: { recent: tally(answers.filter((a) => a.at >= since)), before: tally(answers.filter((a) => a.at < since)) },
    byDirectory: [...byDirectory].map(([path, list]) => ({ path, ...tally(list) })).sort((a, b) => rate(a) - rate(b) || b.answers - a.answers || a.path.localeCompare(b.path)),
    blindSpots: blindSpots(answers),
  };
}
