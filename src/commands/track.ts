import { listTracks, loadTrack, trackProgress, type StepProgress, type TrackRecord } from '../explore/tracks.ts';
import { NOUN } from '../synthesis/schema.ts';
import { findRepoRoot, workspacePaths } from '../workspace.ts';
import { train, type TrainDependencies, type TrainIo, type TrainOptions, type TrainResult } from './train.ts';

const MARKS: Record<StepProgress['status'], string> = {
  attempted: '✓',
  'in-progress': '▶',
  queued: '○',
  discarded: '✗',
  missing: '?',
};

export function formatProgress(track: TrackRecord, steps: StepProgress[], next?: StepProgress): string {
  const done = steps.filter((s) => s.status === 'attempted').length;
  return [
    `Track "${track.title}" (${track.id}): ${track.flow ? `the flow "${track.flow}" (UA)` : track.module || 'the repository'}, ${done} of ${steps.length} done`,
    ...steps.map((s, i) => `  ${MARKS[s.status]} ${i + 1}. ${NOUN[s.kind ?? 'drill']} · ${s.pillar}: ${s.path}${s === next ? '  ← next' : ''}\n       ${s.why}`),
  ].join('\n');
}

export type TrackListing = { track: TrackRecord; done: number; total: number }[];

/** Every Track with how many of its steps are done. */
export async function trackListing(cwd: string): Promise<TrackListing> {
  const paths = workspacePaths(await findRepoRoot(cwd));
  const listing: TrackListing = [];
  for (const track of await listTracks(paths)) {
    const { steps } = await trackProgress(paths, track);
    listing.push({ track, done: steps.filter((s) => s.status === 'attempted').length, total: steps.length });
  }
  return listing;
}

export type TrackResult = TrainResult | { status: 'track-complete'; track: TrackRecord };

/** `fiu track <id>`: show the Track's progress and open its next step (resuming one in progress). */
export async function continueTrack(cwd: string, id: string, options: TrainOptions, io: TrainIo, deps: TrainDependencies = {}): Promise<TrackResult> {
  const paths = workspacePaths(await findRepoRoot(cwd));
  const track = await loadTrack(paths, id);
  const { steps, next } = await trackProgress(paths, track);
  io.print(formatProgress(track, steps, next));
  if (!next) return { status: 'track-complete', track };
  return train(cwd, next.workoutId, options, io, deps);
}
