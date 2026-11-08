import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { buildSkeleton } from '../src/atlas/skeleton.ts';
import { emptyAtlas, writeAtlas } from '../src/atlas/store.ts';
import { profiles } from '../src/languages/registry.ts';
import { buildDebrief, renderDebriefMarkdown, renderDebriefText } from '../src/workouts/debrief.ts';
import type { WorkoutRecord } from '../src/workouts/save.ts';
import { ensureWorkspace, workspacePaths } from '../src/workspace.ts';
import { TS_REFERENCE } from './mock-model.ts';
import { tempGitRepo } from './helpers.ts';

async function commit(repo: string, changes: Record<string, string>) {
  for (const [path, content] of Object.entries(changes)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'change'], { cwd: repo });
}

// queue.ts: line 1 imports the clock, so TS_REFERENCE's pickNext sits on lines 4-10.
const QUEUE = `import { now } from './clock.ts';\n${TS_REFERENCE}`;

/** A queue whose pickNext the worker calls and the dashboard only imports, which changes with a notes file it never imports. */
async function scheduler() {
  const repo = await tempGitRepo();
  const paths = workspacePaths(repo);
  await ensureWorkspace(paths);
  await commit(repo, {
    'src/clock.ts': 'export const now = () => 0;\n',
    'src/worker.ts': "import { pickNext } from './queue.ts';\nexport const run = () => pickNext([]);\n",
    'src/dashboard.ts': "import type { Job } from './queue.ts';\nexport const show = (j: Job) => j.id;\n",
  });
  for (let i = 0; i < 3; i++) await commit(repo, { 'src/queue.ts': `${QUEUE}// ${i}\n`, 'src/notes.ts': `export const v = ${i};\n` });
  const record = {
    id: 'drill_x',
    title: 'Late jobs jump the queue',
    source: { path: 'src/queue.ts', dirty: false },
    sourceAnchors: [{ path: 'src/queue.ts', startLine: 4, endLine: 10, explanation: 'The scheduler picks the next job here.' }],
  } as unknown as WorkoutRecord;
  return { repo, paths, record };
}

describe('the Debrief', () => {
  it("names the target, its callers, the file's tensions, and neighbours to practise", async () => {
    const { repo, paths, record } = await scheduler();
    const skeleton = await buildSkeleton(repo, profiles());
    await writeAtlas(paths, {
      ...emptyAtlas(),
      files: { 'src/queue.ts': { hash: skeleton.files.get('src/queue.ts')!.hash, text: 'The queue jobs wait in.', writtenAt: '', functions: { pickNext: 'Picks the next job to run.' } } },
    });

    const debrief = await buildDebrief({ paths, record, sourceChanged: false, profiles: profiles() });
    assert.deepEqual(debrief.target, [{ name: 'pickNext', text: 'Picks the next job to run.' }]);
    assert.deepEqual(debrief.file, { text: 'The queue jobs wait in.', stale: false });
    assert.deepEqual(debrief.usedBy, ['src/dashboard.ts', 'src/worker.ts']);
    assert.deepEqual(debrief.callers, ['src/worker.ts'], 'the dashboard imports the file but never calls pickNext');
    assert.deepEqual(debrief.signals, [
      'Blast radius: 2 files use this file.',
      'Churn: changed in 3 of the last 4 commits.',
      'Hidden coupling: changes with src/notes.ts (together in 3 commits), though neither imports the other.',
    ]);
    assert.deepEqual(debrief.tryNext, [
      { command: 'fiu predict src/worker.ts', why: 'it calls pickNext' },
      { command: 'fiu diagnose src/notes.ts', why: 'it changes with this file, though neither imports the other' },
      { command: 'fiu drill src/clock.ts', why: 'this file uses it' },
    ]);

    const text = renderDebriefText(debrief);
    assert.match(text, /^Debrief\n {2}Where this lives:\n {4}src\/queue\.ts:4-10: The scheduler picks the next job here\.\n {2}What it is for:\n {4}#pickNext {2}Picks the next job to run\.\n {4}This file: The queue jobs wait in\.\n/);
    assert.match(text, /Used by: src\/dashboard\.ts, src\/worker\.ts \(calling pickNext: src\/worker\.ts\)/);
    assert.match(text, /Try next:\n {4}fiu predict src\/worker\.ts {3,}it calls pickNext/);
    assert.match(text, /not Verified; links and signals are computed/);

    const markdown = renderDebriefMarkdown(debrief, record);
    assert.match(markdown, /^# Debrief: Late jobs jump the queue\n\n## Where this lives\n/);
    assert.match(markdown, /## Tensions\n\n- Blast radius: 2 files use this file\.\n/);
    assert.match(markdown, /## Try next\n\n- `fiu predict src\/worker\.ts`: it calls pickNext\n/);
  });

  it('says when the source changed since the Workout was made', async () => {
    const { paths, record } = await scheduler();
    const text = renderDebriefText(await buildDebrief({ paths, record, sourceChanged: true, profiles: profiles() }));
    assert.match(text, /^Debrief\n {2}The source has changed since this Workout was made/);
  });

  it('with context off, is only where the code lives', async () => {
    const { paths, record } = await scheduler();
    const debrief = await buildDebrief({ paths, record, sourceChanged: true });
    assert.equal(renderDebriefText(debrief), 'Debrief\n  Where this lives:\n    src/queue.ts:4-10: The scheduler picks the next job here.');
  });

  it('is only where the code lives when the source file is gone', async () => {
    const { paths, record } = await scheduler();
    const gone = { ...record, source: { path: 'src/deleted.ts', dirty: false } } as WorkoutRecord;
    const debrief = await buildDebrief({ paths, record: gone, sourceChanged: true, profiles: profiles() });
    assert.deepEqual([debrief.target, debrief.usedBy, debrief.signals, debrief.tryNext], [[], [], [], []]);
  });
});
