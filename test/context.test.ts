import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { coChange } from '../src/atlas/links.ts';
import { buildSkeleton } from '../src/atlas/skeleton.ts';
import { emptyAtlas, writeAtlas, type Atlas } from '../src/atlas/store.ts';
import { resolveConfig } from '../src/config.ts';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { profiles } from '../src/languages/registry.ts';
import { diffLines } from '../src/verify/diff.ts';
import { aroundThisCode, distinctiveTokens, leakChecker, MODEL_WORD, NO_DESCRIPTIONS, targetNames } from '../src/workouts/context.ts';
import { saveDrill, sourceRevision } from '../src/workouts/save.ts';
import { ensureWorkspace, workspacePaths } from '../src/workspace.ts';
import { goodDrill, goodKata, goodPrediction, TS_REFERENCE } from './mock-model.ts';
import { tempGitRepo } from './helpers.ts';

async function commit(repo: string, changes: Record<string, string>) {
  for (const [path, content] of Object.entries(changes)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'change'], { cwd: repo });
}

/** A queue used by a worker, changed together three times, importing a clock. */
async function scheduler() {
  const repo = await tempGitRepo();
  const paths = workspacePaths(repo);
  await ensureWorkspace(paths);
  for (let i = 0; i < 3; i++) {
    await commit(repo, {
      'src/clock.ts': 'export const now = () => 0;\n',
      'src/queue.ts': `import { now } from './clock.ts';\n${TS_REFERENCE}// ${i}\n`,
      'src/worker.ts': `import { pickNext } from './queue.ts';\nexport const n = ${i};\n`,
    });
  }
  const all = profiles();
  const skeleton = await buildSkeleton(repo, all);
  const describe = async (entries: { folder?: string; file?: string; staleFolder?: boolean }) => {
    const atlas: Atlas = emptyAtlas();
    if (entries.folder) atlas.folders.src = { hash: entries.staleFolder ? 'old' : skeleton.folders.get('src')!.hash, text: entries.folder, writtenAt: '' };
    if (entries.file) atlas.files['src/queue.ts'] = { hash: skeleton.files.get('src/queue.ts')!.hash, text: entries.file, writtenAt: '', functions: { pickNext: 'Picks the next job.' } };
    await writeAtlas(paths, atlas);
  };
  const around = (overrides: { symbol?: string; startingCode?: string } = {}) =>
    aroundThisCode({
      paths,
      profiles: all,
      profile: TYPESCRIPT,
      sourcePath: 'src/queue.ts',
      startingCode: overrides.startingCode ?? goodDrill().startingCode,
      referenceSolution: TS_REFERENCE,
      ...(overrides.symbol ? { symbol: overrides.symbol } : {}),
    });
  return { repo, paths, describe, around };
}

describe('the target and what only the changed lines say', () => {
  it("finds the functions a Drill's change falls in, and the #symbol asked for", () => {
    const drill = goodDrill();
    const names = targetNames({ referenceSolution: TS_REFERENCE, profile: TYPESCRIPT, symbol: 'Queue.drain' }, diffLines(TS_REFERENCE, drill.startingCode));
    assert.deepEqual(names.sort(), ['Queue.drain', 'drain', 'pickNext']);
  });

  it("finds the function a Kata's gap was cut from", () => {
    assert.deepEqual(targetNames({ referenceSolution: TS_REFERENCE, profile: TYPESCRIPT }, diffLines(TS_REFERENCE, goodKata().startingCode)), ['pickNext']);
  });

  it('keeps identifiers only the changed lines use, numbers other than 0 and 1, and strings', () => {
    const solution = 'export function retry(n: number) {\n  const attempts = n;\n  if (attempts < maxBackoff * 42) return "give up";\n  return 1;\n}\n';
    const starting = solution.replace('maxBackoff * 42', 'maxBackoff * 24');
    const tokens = distinctiveTokens(solution, diffLines(solution, starting));
    assert.ok(tokens.includes('maxBackoff') && tokens.includes('42') && tokens.includes('24') && tokens.includes('give up'));
    assert.ok(!tokens.includes('attempts'), 'used elsewhere in the unit: ordinary vocabulary');
    assert.ok(!tokens.includes('return'), 'too common to give anything away');
  });

  it('matches names as written and as spoken, as whole words only', () => {
    const leaks = leakChecker(['pickNext'], ['maxBackoff', '42']);
    assert.ok(leaks('Calls pickNext to choose.'));
    assert.ok(leaks('Waits up to the max backoff.'));
    assert.ok(leaks('Gives up after 42 tries.'));
    assert.ok(!leaks('Picks the next job, 420 at most.'));
  });
});

describe('Around this code', () => {
  it('shows the folder and file entries and the links, around the target and never inside', async () => {
    const { describe: atlas, around } = await scheduler();
    await atlas({ folder: 'The job scheduler.', file: 'The queue jobs wait in.' });
    const section = (await around())!;
    assert.deepEqual(section.lines, [
      '## Around this code',
      '',
      '- **Folder `src/`:** The job scheduler.',
      '- **This file:** The queue jobs wait in.',
      '- **Used by:** `src/worker.ts`',
      '- **Uses:** `src/clock.ts`',
      '- **Changes with:** `src/worker.ts`',
      '',
      MODEL_WORD,
    ]);
    assert.equal(section.dropped, 0);
    assert.doesNotMatch(section.lines.join('\n'), /Picks the next job/, "the target function's own entry never appears");
  });

  it('drops a description that names the target, and counts it', async () => {
    const { describe: atlas, around } = await scheduler();
    await atlas({ folder: 'The job scheduler.', file: 'Holds the jobs; pickNext chooses which runs.' });
    const section = (await around())!;
    assert.equal(section.dropped, 1);
    assert.doesNotMatch(section.lines.join('\n'), /pickNext|This file/);
    assert.match(section.lines.join('\n'), /The job scheduler/);
  });

  it('marks an entry written before the code last changed', async () => {
    const { describe: atlas, around } = await scheduler();
    await atlas({ folder: 'The job scheduler.', staleFolder: true });
    assert.ok((await around())!.lines.includes('- **Folder `src/`:** The job scheduler. *(written before the code last changed)*'));
  });

  it('without an Atlas: the links alone, and a nudge', async () => {
    const { around } = await scheduler();
    const lines = (await around())!.lines;
    assert.ok(!lines.some((line) => line.includes('Folder')));
    assert.equal(lines.at(-1), NO_DESCRIPTIONS);
  });

  it('is left out when there is nothing around the code', async () => {
    const repo = await tempGitRepo();
    const paths = workspacePaths(repo);
    await ensureWorkspace(paths);
    await commit(repo, { 'queue.ts': TS_REFERENCE });
    const section = await aroundThisCode({ paths, profiles: profiles(), profile: TYPESCRIPT, sourcePath: 'queue.ts', startingCode: goodDrill().startingCode, referenceSolution: TS_REFERENCE });
    assert.equal(section, undefined);
    assert.equal(await aroundThisCode({ paths, profiles: profiles(), profile: TYPESCRIPT, sourcePath: 'missing.ts', startingCode: '', referenceSolution: '' }), undefined);
  });
});

describe('hubs', () => {
  it('are files that change with a third or more of the others (and at least 5), left out of "Changes with"', async () => {
    const repo = await tempGitRepo();
    const paths = workspacePaths(repo);
    await ensureWorkspace(paths);
    const others = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const name of others) for (let i = 0; i < 3; i++) await commit(repo, { 'hub.ts': `// ${name}${i}\n`, [`${name}.ts`]: `// ${i}\n` });
    const history = await coChange(repo, new Set(['hub.ts', ...others.map((n) => `${n}.ts`)]));
    assert.deepEqual(history.hubs, ['hub.ts']);

    await commit(repo, { 'a.ts': TS_REFERENCE });
    const section = await aroundThisCode({ paths, profiles: profiles(), profile: TYPESCRIPT, sourcePath: 'a.ts', startingCode: goodDrill().startingCode, referenceSolution: TS_REFERENCE });
    assert.equal(section, undefined, 'the only file a.ts changes with is the hub');
  });
});

describe('saving a Workout with Around this code', () => {
  it("puts it between the title and the brief of a Drill's README, and in workout.json", async () => {
    const { repo, paths, describe: atlas } = await scheduler();
    await atlas({ folder: 'The job scheduler.' });
    const record = await saveDrill({
      paths,
      profile: TYPESCRIPT,
      drill: goodDrill(),
      sourcePath: 'src/queue.ts',
      revision: await sourceRevision(repo, 'src/queue.ts'),
      generationAttempts: 1,
      contextProfiles: profiles(),
    });
    const readme = await readFile(join(paths.workoutsDir, record.id, 'README.md'), 'utf8');
    assert.match(readme, /^# Late jobs jump the queue\n\n## Around this code\n\n- \*\*Folder `src\/`:\*\* The job scheduler\.\n[\s\S]*\n\n## Symptom\n/);
    assert.equal(record.around?.lines[0], '## Around this code');
    const saved = JSON.parse(await readFile(join(paths.workoutsDir, record.id, 'workout.json'), 'utf8'));
    assert.deepEqual(saved.around, record.around);
  });

  it('adds it to Katas but not yet to Predictions, and not when it is off', async () => {
    const { repo, paths } = await scheduler();
    const base = { paths, profile: TYPESCRIPT, sourcePath: 'src/queue.ts', revision: await sourceRevision(repo, 'src/queue.ts'), generationAttempts: 1 };
    assert.ok((await saveDrill({ ...base, drill: goodKata(), kind: 'kata', contextProfiles: profiles() })).around);
    assert.equal((await saveDrill({ ...base, drill: goodPrediction(), kind: 'prediction', contextProfiles: profiles() })).around, undefined);
    assert.equal((await saveDrill({ ...base, drill: goodDrill({ slug: 'off' }) })).around, undefined);
  });

  it('is on unless the repository turns it off', () => {
    assert.equal(resolveConfig({}, {}).context, true);
    assert.equal(resolveConfig({ context: false }, {}).context, false);
  });
});
