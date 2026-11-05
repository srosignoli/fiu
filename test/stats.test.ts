import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { buildMap } from '../src/map/map.ts';
import { renderMap, renderStats } from '../src/map/render.ts';
import { blindSpots, firstAnswers, answerStats } from '../src/map/stats.ts';
import { openAttempt, saveAttempt, type Confidence } from '../src/workouts/attempts.ts';
import { saveDrill, sourceRevision } from '../src/workouts/save.ts';
import { loadWorkout } from '../src/workouts/store.ts';
import { ensureWorkspace, workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';
import { goodPrediction, TS_REFERENCE } from './mock-model.ts';

async function repo() {
  const dir = await tempGitRepo();
  for (const file of ['core/queue.ts', 'core/store.ts', 'web/page.ts']) {
    await mkdir(join(dir, file, '..'), { recursive: true });
    await writeFile(join(dir, file), TS_REFERENCE);
  }
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
  const paths = workspacePaths(dir);
  await ensureWorkspace(paths);
  let n = 0;
  /** A Prediction on `file`, answered `right` or not at `confidence`, finished at `at`. */
  const answer = async (file: string, right: boolean, confidence: Confidence | undefined, at: string) => {
    const record = await saveDrill({ paths, profile: TYPESCRIPT, drill: goodPrediction({ slug: `p${++n}` }), kind: 'prediction', sourcePath: file, revision: await sourceRevision(dir, file), generationAttempts: 1 });
    await finish(record.id, right, confidence, at);
    return record.id;
  };
  const finish = async (id: string, right: boolean, confidence: Confidence | undefined, at: string) => {
    const { attempt } = await openAttempt(paths, await loadWorkout(paths, id), TYPESCRIPT);
    Object.assign(attempt.record, { outcome: right ? 'completed' : 'abandoned', finishedAt: at, ...(confidence ? { confidence } : {}) });
    await saveAttempt(attempt);
  };
  return { dir, paths, answer, finish };
}

describe('first answers and Blind Spots', () => {
  it('counts only the first Attempt at each Prediction', async () => {
    const { paths, answer, finish } = await repo();
    const id = await answer('core/queue.ts', false, 'certain', '2026-10-01T10:00:00.000Z');
    await finish(id, true, 'certain', '2026-10-02T10:00:00.000Z');
    assert.deepEqual((await firstAnswers(paths)).map((a) => [a.right, a.confidence]), [[false, 'certain']]);
  });

  it('marks a file whose latest first answer was certain and wrong, and clears it with a later right answer', async () => {
    const { paths, answer } = await repo();
    await answer('core/queue.ts', false, 'certain', '2026-10-01T10:00:00.000Z');
    await answer('core/store.ts', false, 'fairly-sure', '2026-10-01T11:00:00.000Z');
    await answer('web/page.ts', false, 'certain', '2026-10-01T12:00:00.000Z');
    await answer('web/page.ts', true, 'guessing', '2026-10-02T12:00:00.000Z');
    assert.deepEqual(blindSpots(await firstAnswers(paths)).map((b) => b.path), ['core/queue.ts']);
  });
});

describe('fiu stats', () => {
  it('tallies accuracy, calibration, the trend, and directories, and renders rates only with enough answers', async () => {
    const { dir, answer } = await repo();
    await answer('core/queue.ts', true, 'certain', '2026-09-01T10:00:00.000Z');
    await answer('core/queue.ts', true, 'certain', '2026-09-02T10:00:00.000Z');
    await answer('core/store.ts', false, 'certain', '2026-10-20T10:00:00.000Z');
    await answer('web/page.ts', true, 'guessing', '2026-10-21T10:00:00.000Z');
    await answer('web/page.ts', true, undefined, '2026-10-22T10:00:00.000Z');
    const stats = await answerStats(dir, '', new Date('2026-10-31T00:00:00.000Z'));
    assert.deepEqual(stats.overall, { answers: 5, right: 4 });
    assert.deepEqual(stats.calibration.map((c) => [c.confidence, c.answers, c.right]), [['guessing', 1, 1], ['fairly-sure', 0, 0], ['certain', 3, 2]]);
    assert.deepEqual(stats.trend, { recent: { answers: 3, right: 2 }, before: { answers: 2, right: 2 } });
    assert.deepEqual(stats.byDirectory.map((d) => [d.path, d.answers, d.right]), [['core', 3, 2], ['web', 2, 2]]);
    assert.deepEqual(stats.blindSpots.map((b) => b.path), ['core/store.ts']);

    const text = renderStats(stats, { color: false });
    assert.match(text, /^Your answers: 80% right \(4 of 5, first answers only\)/);
    assert.match(text, /Guessing {8}— right {2}\(1 of 1; expected about 25%\)\n/);
    assert.match(text, /Certain {7}67% right {2}\(2 of 3; expected about 95%\) {2}overconfident/);
    assert.match(text, /Last 30 days: 67% \(2 of 3\); before: — \(2 of 2\)/);
    assert.match(text, /⚠ Blind Spots: you were certain, and wrong\n {2}core\/store\.ts {3}check again: fiu predict core\/store\.ts/);

    const web = await answerStats(dir, 'web');
    assert.deepEqual(web.overall, { answers: 2, right: 2 });
  });

  it('says how to start when nothing is answered', async () => {
    const { dir } = await repo();
    assert.equal(renderStats(await answerStats(dir), { color: false }), 'Nothing answered yet. Ask for a Prediction with: fiu predict');
  });
});

describe('Blind Spots in fiu map', () => {
  it('marks the file, counts it in its directory, and suggests checking it first', async () => {
    const { dir, answer } = await repo();
    await answer('core/store.ts', false, 'certain', '2026-10-20T10:00:00.000Z');
    const configEnv = { env: {}, home: await tempDir() };
    const report = await buildMap(dir, '', { configEnv });
    assert.deepEqual(report.suggestions[0], { kind: 'check', path: 'core/store.ts' });
    const text = renderMap(report, { color: false });
    assert.match(text, /⚠ Blind Spot: you were certain, and wrong/);
    assert.match(text, /core +.*⚠1/);
    assert.match(text, /fiu predict core\/store\.ts {3}\(you were certain about it, and wrong: check your picture again\)/);
    assert.match(renderMap(await buildMap(dir, 'core', { configEnv }), { color: false }), /store\.ts +⚠ /);
  });
});
