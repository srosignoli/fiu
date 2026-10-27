import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { execa } from 'execa';
import { describeCost, type Cost } from '../cost/usage.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import type { DrillOutput } from '../synthesis/schema.ts';
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

/** The Track a Drill belongs to. Step order lives in the Track's manifest, not here: a dropped step would make a number here wrong for good. */
export interface TrackPlacement {
  id: string;
  title: string;
  why: string;
}

/** The metadata saved beside a Workout as workout.json. */
export interface WorkoutRecord {
  id: string;
  kind: 'drill';
  /** Absent on Workouts made before agent mode: those are `kintsugi`. */
  generator?: Generator;
  /** Absent on Workouts made before agent mode: those are `manual`. */
  origin?: Origin;
  /** For Origin `commit`: the commit it was generated from, and whether an AI co-authored it. */
  commit?: { sha: string; aiAuthored: boolean };
  /** For Origin `explore`: the Track this Drill is a step of. */
  track?: TrackPlacement;
  title: string;
  slug: string;
  pillar: DrillOutput['pillar'];
  estimatedMinutes: number;
  language: string;
  createdAt: string;
  source: { path: string; symbol?: string } & SourceRevision;
  sourceAnchors: SourceAnchor[];
  hints: string[];
  regressionTestName: string;
  injectedBugDescription: string;
  /** What generating this Workout cost, across all its generation attempts. Absent when the user's agent generated it (not measured) and on Workouts made before cost recording. */
  cost?: Cost & { generationAttempts: number };
  /** `solution` is the Reference Solution; `originalTest` the tests the Workout was Verified with. */
  files: { code: string; test: string; solution: string; originalTest: string };
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
  drill: DrillOutput;
  /** The source file, relative to the repository root. */
  sourcePath: string;
  symbol?: string;
  revision: SourceRevision;
  /** Absent when the user's agent generated the Workout: its cost isn't measured. */
  cost?: Cost;
  generationAttempts: number;
  generator?: Generator;
  origin?: Origin;
  commit?: { sha: string; aiAuthored: boolean };
  track?: TrackPlacement;
  now?: Date;
}

/** Writes a Verified Drill into .kintsugi/workouts/<id>/ and returns its record. */
export async function saveDrill({
  paths,
  profile,
  drill,
  sourcePath,
  symbol,
  revision,
  cost,
  generationAttempts,
  generator = 'kintsugi',
  origin = 'manual',
  commit,
  track,
  now = new Date(),
}: SaveDrillOptions): Promise<WorkoutRecord> {
  const id = uniqueId(paths, `drill_${now.toISOString().slice(0, 10).replaceAll('-', '')}_${drill.slug}`);
  const dir = join(paths.workoutsDir, id);
  const solution = join(SOLUTION_DIRNAME, profile.codeFilename);
  const originalTest = join(SOLUTION_DIRNAME, profile.testFilename);

  const record: WorkoutRecord = {
    id,
    kind: 'drill',
    generator,
    origin,
    ...(commit ? { commit } : {}),
    ...(track ? { track } : {}),
    title: drill.title,
    slug: drill.slug,
    pillar: drill.pillar,
    estimatedMinutes: drill.estimatedMinutes,
    language: profile.id,
    createdAt: now.toISOString(),
    source: { path: sourcePath, ...(symbol ? { symbol } : {}), ...revision },
    sourceAnchors: drill.sourceAnchors.map((anchor) => ({ path: sourcePath, ...anchor, commit: revision.commit })),
    hints: drill.hints,
    regressionTestName: drill.regressionTestName,
    injectedBugDescription: drill.injectedBugDescription,
    ...(cost ? { cost: { ...cost, generationAttempts } } : {}),
    files: { code: profile.codeFilename, test: profile.testFilename, solution, originalTest },
  };

  const files: Record<string, string> = {
    ...profile.supportFiles,
    'README.md': readme(drill, record, dir, paths.repoRoot),
    [profile.codeFilename]: drill.startingCode,
    [profile.testFilename]: drill.testSuiteCode,
    [solution]: drill.referenceSolution,
    [originalTest]: drill.testSuiteCode,
    'workout.json': JSON.stringify(record, null, 2) + '\n',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return record;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function uniqueId(paths: WorkspacePaths, base: string): string {
  const taken = (id: string) => existsSync(join(paths.workoutsDir, id)) || existsSync(join(paths.doneDir, id));
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

function readme(drill: DrillOutput, record: WorkoutRecord, dir: string, repoRoot: string): string {
  const link = relative(dir, join(repoRoot, record.source.path)).split('\\').join('/');
  const anchors = record.sourceAnchors.map(
    (a) => `- [${a.path}:${a.startLine}-${a.endLine}](${link}#L${a.startLine}-L${a.endLine}): ${a.explanation}`,
  );
  const { commit, dirty } = record.source;
  const revision = commit
    ? `Derived from commit \`${commit.slice(0, 12)}\`${dirty ? ' plus uncommitted changes' : ''}.`
    : 'Derived from uncommitted code.';
  const cost = record.cost
    ? `Generated for ${describeCost(record.cost)} over ${plural(record.cost.generationAttempts, 'attempt')} (estimated with prices as of ${record.cost.pricesAsOf}).`
    : 'Generated by your coding agent (cost not measured: it used your agent\'s plan).';
  const placement = record.track ? [`*Part of the Track "${record.track.title}": ${record.track.why}*`, ''] : [];
  return [`# ${drill.title}`, '', ...placement, drill.readmeMarkdown.trim(), '', '## Source', '', ...anchors, '', revision, '', cost, ''].join('\n');
}
