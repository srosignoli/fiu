import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { buildMap, type FileEntry, type MapReport } from '../src/map/map.ts';
import { renderMap } from '../src/map/render.ts';
import { openAttempt, saveAttempt } from '../src/workouts/attempts.ts';
import { saveDrill, sourceRevision } from '../src/workouts/save.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';
import { goodDrill } from './mock-model.ts';

/** A source file of 20 lines with `branches` branching lines: its logic density is under our control. */
const source = (name: string, branches: number) =>
  [
    ...Array.from({ length: branches }, (_, i) => `export const ${name}${i} = (x: number) => (x > ${i} && x < 99 ? x : ${i});`),
    ...Array.from({ length: 20 - branches }, (_, i) => `export const ${name}Plain${i} = ${i};`),
  ].join('\n') + '\n';

const AI = 'Co-Authored-By: Claude <noreply@anthropic.com>';

async function commit(repo: string, files: Record<string, string>, message: string) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(repo, name, '..'), { recursive: true });
    await writeFile(join(repo, name), content);
  }
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message], { cwd: repo });
}

/**
 * core/: dense.ts and dense2.ts (complex), mid.ts (AI-changed, mid logic), glue.ts (AI-changed, low
 * logic), practised.ts (with a finished Attempt), and a test file; util/: simple files only.
 */
async function repo() {
  const dir = await tempGitRepo();
  await commit(dir, {
    'core/dense.ts': source('d', 18),
    'core/dense2.ts': source('e', 17),
    'core/practised.ts': source('p', 8),
    'core/glue.ts': source('g', 1),
    'core/dense.test.ts': source('t', 20),
    'util/a.ts': source('a', 2),
    'util/b.ts': source('b', 3),
    'util/c.ts': source('c', 2),
  }, 'initial, written by hand');
  await commit(dir, { 'core/mid.ts': source('m', 10), 'core/glue.ts': source('g', 2) }, `Add mid\n\n${AI}`);
  const paths = workspacePaths(dir);
  await ensureWorkspace(paths);
  await excludeWorkspaceFromGit(dir);
  return { dir, paths };
}

async function practise(dir: string, path: string, outcome: 'completed' | 'abandoned' = 'completed') {
  const paths = workspacePaths(dir);
  const record = await saveDrill({
    paths,
    profile: TYPESCRIPT,
    drill: goodDrill({ slug: path.replace(/\W/g, '-') }),
    sourcePath: path,
    revision: await sourceRevision(dir, path),
    generationAttempts: 1,
  });
  const { attempt } = await openAttempt(paths, { record, dir: join(paths.workoutsDir, record.id) }, TYPESCRIPT);
  Object.assign(attempt.record, { outcome, finishedAt: new Date().toISOString() });
  await saveAttempt(attempt);
  return record.id;
}

const fileIn = (report: MapReport, path: string): FileEntry | undefined => report.dirs.flatMap((d) => d.files).find((f) => f.path === path);
const options = async () => ({ configEnv: { env: {}, home: await tempDir() } });

describe('kin map', () => {
  it('colours files by practice, staleness, recent AI changes, and logic', async () => {
    const { dir } = await repo();
    await practise(dir, 'core/practised.ts');
    const report = await buildMap(dir, '', await options());
    const state = (path: string) => fileIn(report, path)?.state;
    assert.equal(state('core/dense.ts'), 'red', 'complex, never practised');
    assert.equal(state('core/dense2.ts'), 'red');
    assert.equal(state('core/mid.ts'), 'amber', 'AI-changed, real logic, never practised');
    assert.equal(state('core/glue.ts'), 'grey', 'AI-changed glue below the median is nothing to worry about');
    assert.equal(state('core/practised.ts'), 'green');
    assert.equal(state('core/dense.test.ts'), 'grey', 'tests are never debt');
    assert.equal(state('util/a.ts'), 'grey');

    const core = report.dirs.find((d) => d.path === 'core')!;
    assert.deepEqual([core.state, core.counts], ['red', { red: 2, amber: 1, green: 1 }]);
    assert.equal(report.dirs.find((d) => d.path === 'util')!.state, 'grey');
  });

  it('marks practice Stale once the file changes 20 lines or more', async () => {
    const { dir } = await repo();
    await practise(dir, 'core/practised.ts', 'abandoned');
    await commit(dir, { 'core/practised.ts': source('p', 8).replace(/export const p/g, 'export const q') }, 'rename a lot');
    const file = fileIn(await buildMap(dir, '', await options()), 'core/practised.ts')!;
    assert.deepEqual([file.state, file.practice], ['amber', 'abandoned']);
    assert.ok(file.staleBy! >= 20);

    // A light edit doesn't undo understanding.
    const { dir: other } = await repo();
    await practise(other, 'core/practised.ts');
    await commit(other, { 'core/practised.ts': `${source('p', 8)}// a comment\n` }, 'light touch');
    assert.equal(fileIn(await buildMap(other, '', await options()), 'core/practised.ts')!.state, 'green');
  });

  it('suggests Drills already waiting first, then exploring the reddest directory', async () => {
    const { dir, paths } = await repo();
    const waiting = await saveDrill({
      paths,
      profile: TYPESCRIPT,
      drill: goodDrill({ slug: 'waiting' }),
      sourcePath: 'core/mid.ts',
      revision: await sourceRevision(dir, 'core/mid.ts'),
      generationAttempts: 1,
    });
    const report = await buildMap(dir, '', await options());
    assert.deepEqual(report.suggestions.slice(0, 2), [
      { kind: 'train', workoutId: waiting.id, path: 'core/mid.ts' },
      { kind: 'explore', path: 'core', red: 2 },
    ]);
    const text = renderMap(report, { color: false });
    assert.match(text, /kin train drill_\d{8}_waiting {3}\(a Drill is already waiting for core\/mid\.ts\)/);
    assert.match(text, /kin explore core {3}\(2 complex files never practised\)/);
    assert.doesNotMatch(text, /^ {2}. util/m, 'quiet directories fold into one line');
    assert.match(text, /… and 1 directory with nothing to worry about/);
  });

  it('drills into one directory', async () => {
    const { dir } = await repo();
    const report = await buildMap(dir, 'core', await options());
    assert.deepEqual(report.dirs.map((d) => d.path), ['core']);
    const text = renderMap(report, { color: false });
    assert.match(text, /^core {2}●2 ◐1$/m);
    assert.match(text, /^ {2}● dense\.ts +complex, never practised$/m);
    assert.match(text, /^ {2}◐ mid\.ts +changed by AI recently, never practised$/m);
  });
});
