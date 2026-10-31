import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { execa } from 'execa';
import { describeCost, type Cost } from '../cost/usage.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import type { AnyWorkoutOutput, PredictionOption, WorkoutKind } from '../synthesis/schema.ts';
import { findOriginalDefect, type OriginalDefect } from '../verify/defect.ts';
import type { WorkspacePaths } from '../workspace.ts';

export const SOLUTION_DIRNAME = '.solution';

/** Where a Workout came from: the commit its Source Anchors point into. */
export interface SourceRevision {
  /** HEAD when the Workout was made; absent in a repository with no commits. */
  commit?: string;
  /** True when the source file differed from that commit (or was untracked). */
  dirty: boolean;
}

export interface SourceAnchor {
  path: string;
  startLine: number;
  endLine: number;
  explanation: string;
  commit?: string;
}

/** Who wrote a Workout's content: Kintsugi via the user's API key, or the user's coding agent. */
export type Generator = 'kintsugi' | 'agent';
/** Why a Workout exists: the user asked for it, an agent made it at the end of its own task, a commit triggered it, or it is a Track step. */
export type Origin = 'manual' | 'agent-task' | 'commit' | 'explore';

/** Who shared a Workout or Track with the team, stamped when it was shared. */
export interface SharedBy {
  name: string;
  email: string;
  at: string;
}

/** The Track a Drill belongs to. Step order lives in the Track's manifest, not here: a dropped step would make a number here wrong for good. */
export interface TrackPlacement {
  id: string;
  /** Absent when an agent builds the Track: it names the Track only after its Drills are saved. */
  title?: string;
  /** The module the Track teaches, relative to the repository root. */
  module: string;
  why: string;
}

/** A question's place in its Series (§11.11). */
export interface SeriesPlacement {
  id: string;
  /** 1-based. */
  index: number;
  /** How many questions the Series saved. */
  of: number;
}

/** The metadata saved beside a Workout as workout.json. */
export interface WorkoutRecord {
  id: string;
  kind: WorkoutKind;
  /** Absent on Workouts made before agent mode: those are `kintsugi`. */
  generator?: Generator;
  /** Absent on Workouts made before agent mode: those are `manual`. */
  origin?: Origin;
  /** For Origin `commit`: the commit it was generated from, and whether an AI co-authored it. */
  commit?: { sha: string; aiAuthored: boolean; subject?: string };
  /** For Origin `explore`: the Track this Drill is a step of. */
  track?: TrackPlacement;
  /** For a question of a Prediction Series: which Series, and where in it. */
  series?: SeriesPlacement;
  /** Set on Workouts fetched from the team's shared branch: who shared them. */
  sharedBy?: SharedBy;
  title: string;
  slug: string;
  pillar: AnyWorkoutOutput['pillar'];
  estimatedMinutes: number;
  language: string;
  createdAt: string;
  source: { path: string; symbol?: string } & SourceRevision;
  sourceAnchors: SourceAnchor[];
  hints: string[];
  /** Drill only: the test that exposes the injected bug. */
  regressionTestName?: string;
  /** Drill only: internal note on the bug. */
  injectedBugDescription?: string;
  /** Kata only: internal note on what was removed and what a correct fill must do. */
  gapSummary?: string;
  /** Prediction only: what the human reads, and the answer (the options in the order they were written; Attempts shuffle them). */
  prediction?: { scenario: string; explanation: string; options: PredictionOption[] };
  /** A bug the source file appears to contain already. Shown only after an Attempt. */
  originalDefect?: OriginalDefect;
  /** What generating this Workout cost, across all its generation attempts. Absent when the user's agent generated it (not measured) and on Workouts made before cost recording. */
  cost?: Cost & { generationAttempts: number };
  /** `solution` is the Reference Solution; `originalTest` the tests the Workout was Verified with; `previous`, for a Prediction from a commit, the Previous Version. */
  files: { code: string; test: string; solution: string; originalTest: string; previous?: string };
}

export async function sourceRevision(repoRoot: string, path: string): Promise<SourceRevision> {
  const head = await execa('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repoRoot, reject: false });
  if (head.exitCode !== 0) return { dirty: true };
  const status = await execa('git', ['status', '--porcelain', '--', path], { cwd: repoRoot });
  return { commit: head.stdout.trim(), dirty: status.stdout.trim() !== '' };
}

export interface SaveDrillOptions {
  paths: WorkspacePaths;
  profile: LanguageProfile;
  /** The generated Workout, of either kind. */
  drill: AnyWorkoutOutput;
  kind?: WorkoutKind;
  /** The source file, relative to the repository root. */
  sourcePath: string;
  symbol?: string;
  /** The source file as sent to the generator, where the Workout's bug is looked for. Absent: not looked for. */
  source?: string;
  revision: SourceRevision;
  /** Absent when the user's agent generated the Workout: its cost isn't measured. */
  cost?: Cost;
  generationAttempts: number;
  generator?: Generator;
  origin?: Origin;
  commit?: { sha: string; aiAuthored: boolean; subject?: string };
  track?: TrackPlacement;
  series?: SeriesPlacement;
  now?: Date;
}

/** Writes a Verified Drill or Kata into .kintsugi/workouts/<id>/ and returns its record. */
export async function saveDrill({
  paths,
  profile,
  drill,
  kind = 'drill',
  sourcePath,
  symbol,
  source,
  revision,
  cost,
  generationAttempts,
  generator = 'kintsugi',
  origin = 'manual',
  commit,
  track,
  series,
  now = new Date(),
}: SaveDrillOptions): Promise<WorkoutRecord> {
  const id = uniqueId(paths, `${kind}_${now.toISOString().slice(0, 10).replaceAll('-', '')}_${drill.slug}`);
  const dir = join(paths.workoutsDir, id);
  const solution = join(SOLUTION_DIRNAME, profile.codeFilename);
  const originalTest = join(SOLUTION_DIRNAME, profile.testFilename);
  const previous = drill.previous ? join(SOLUTION_DIRNAME, `previous${extname(profile.codeFilename)}`) : undefined;
  const originalDefect = source === undefined ? undefined : findOriginalDefect(kind, drill, source, profile.lineComment);

  const record: WorkoutRecord = {
    id,
    kind,
    generator,
    origin,
    ...(commit ? { commit } : {}),
    ...(track ? { track } : {}),
    ...(series ? { series } : {}),
    title: drill.title,
    slug: drill.slug,
    pillar: drill.pillar,
    estimatedMinutes: drill.estimatedMinutes,
    language: profile.id,
    createdAt: now.toISOString(),
    source: { path: sourcePath, ...(symbol ? { symbol } : {}), ...revision },
    sourceAnchors: drill.sourceAnchors.map((anchor) => ({ path: sourcePath, ...anchor, commit: revision.commit })),
    hints: drill.hints ?? [],
    ...(kind === 'drill'
      ? { regressionTestName: drill.regressionTestName, injectedBugDescription: drill.injectedBugDescription }
      : kind === 'kata'
        ? { gapSummary: drill.gapSummary }
        : { prediction: { scenario: drill.scenario ?? '', explanation: drill.explanation ?? '', options: drill.options ?? [] } }),
    ...(originalDefect ? { originalDefect } : {}),
    ...(cost ? { cost: { ...cost, generationAttempts } } : {}),
    // A Prediction has no code to work on: its code and tests are the ones it was Verified with.
    files: kind === 'prediction'
      ? { code: solution, test: originalTest, solution, originalTest, ...(previous ? { previous } : {}) }
      : { code: profile.codeFilename, test: profile.testFilename, solution, originalTest },
  };

  const files: Record<string, string> = {
    ...(kind === 'prediction'
      ? {}
      : { ...profile.supportFiles, [profile.codeFilename]: drill.startingCode ?? '', [profile.testFilename]: drill.testSuiteCode }),
    'README.md': kind === 'prediction' ? predictionReadme(record) : readme(drill, record, dir, paths.repoRoot),
    [solution]: drill.referenceSolution,
    [originalTest]: drill.testSuiteCode,
    ...(previous ? { [previous]: drill.previous! } : {}),
    'workout.json': JSON.stringify(record, null, 2) + '\n',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return record;
}

/** A new Series id, `series_<date>_<slug>`, not taken by any Workout's Series. */
export async function newSeriesId(paths: WorkspacePaths, slug: string, now = new Date()): Promise<string> {
  const base = `series_${now.toISOString().slice(0, 10).replaceAll('-', '')}_${slug}`;
  const taken = new Set<string>();
  for (const dir of existsSync(paths.workoutsDir) ? await readdir(paths.workoutsDir) : []) {
    const json = await readFile(join(paths.workoutsDir, dir, 'workout.json'), 'utf8').catch(() => undefined);
    const id = json ? (JSON.parse(json) as WorkoutRecord).series?.id : undefined;
    if (id) taken.add(id);
  }
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function uniqueId(paths: WorkspacePaths, base: string): string {
  const taken = (id: string) => existsSync(join(paths.workoutsDir, id)) || existsSync(join(paths.doneDir, id));
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

function provenance(record: WorkoutRecord): string[] {
  const { commit, dirty } = record.source;
  const revision = commit
    ? `Derived from commit \`${commit.slice(0, 12)}\`${dirty ? ' plus uncommitted changes' : ''}.`
    : 'Derived from uncommitted code.';
  const cost = record.cost
    ? `Generated for ${describeCost(record.cost)} over ${plural(record.cost.generationAttempts, 'attempt')} (estimated with prices as of ${record.cost.pricesAsOf}).`
    : 'Generated by your coding agent (cost not measured: it used your agent\'s plan).';
  return [revision, '', cost];
}

/**
 * Written by Kintsugi, not the model: the Scenario and the options, sorted so the order they were written
 * in gives nothing away. The answer and the Source Anchors stay in workout.json until after answering.
 */
function predictionReadme(record: WorkoutRecord): string {
  const { scenario, options } = record.prediction!;
  const sorted = options.map((o) => o.text.trim()).sort((a, b) => a.localeCompare(b));
  return [
    `# ${record.title}`,
    '',
    ...(record.series ? [`*Question ${record.series.index} of ${record.series.of} about \`${record.source.path}\`.*`, ''] : []),
    '## Scenario',
    '',
    scenario.trim(),
    '',
    '## What happens?',
    '',
    ...sorted.map((text) => `- ${text}`),
    '',
    `Answer with \`kin train ${record.id}\`.`,
    '',
    `## Source`,
    '',
    `\`${record.source.path}\`. ${provenance(record).join('\n')}`,
    '',
  ].join('\n');
}

function readme(drill: AnyWorkoutOutput, record: WorkoutRecord, dir: string, repoRoot: string): string {
  const link = relative(dir, join(repoRoot, record.source.path)).split('\\').join('/');
  const anchors = record.sourceAnchors.map(
    (a) => `- [${a.path}:${a.startLine}-${a.endLine}](${link}#L${a.startLine}-L${a.endLine}): ${a.explanation}`,
  );
  const trackName = record.track?.title ? `the Track "${record.track.title}"` : `a Track on ${record.track?.module || 'this repository'}`;
  const placement = record.track ? [`*Part of ${trackName}: ${record.track.why}*`, ''] : [];
  return [`# ${drill.title}`, '', ...placement, (drill.readmeMarkdown ?? '').trim(), '', '## Source', '', ...anchors, '', ...provenance(record), ''].join('\n');
}
