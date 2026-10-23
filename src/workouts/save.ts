import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { execa } from 'execa';
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

/** The metadata saved beside a Workout as workout.json. */
export interface WorkoutRecord {
  id: string;
  kind: 'drill';
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
  now?: Date;
}

/** Writes a Verified Drill into .kintsugi/workouts/<id>/ and returns its record. */
export async function saveDrill({ paths, profile, drill, sourcePath, symbol, revision, now = new Date() }: SaveDrillOptions): Promise<WorkoutRecord> {
  const id = uniqueId(paths, `drill_${now.toISOString().slice(0, 10).replaceAll('-', '')}_${drill.slug}`);
  const dir = join(paths.workoutsDir, id);
  const solution = join(SOLUTION_DIRNAME, profile.codeFilename);
  const originalTest = join(SOLUTION_DIRNAME, profile.testFilename);

  const record: WorkoutRecord = {
    id,
    kind: 'drill',
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
  return [`# ${drill.title}`, '', drill.readmeMarkdown.trim(), '', '## Source', '', ...anchors, '', revision, ''].join('\n');
}
