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
import { answerPicker, answerTexts, aroundThisCode, distinctiveTokens, leakChecker, MODEL_WORD, MODEL_WORD_UA, NO_DESCRIPTIONS, otherVersions, targetNames } from '../src/workouts/context.ts';
import { saveDrill, sourceRevision } from '../src/workouts/save.ts';
import { ensureWorkspace, workspacePaths } from '../src/workspace.ts';
import { goodDiagnosis, goodDrill, goodKata, goodPrediction, TS_REFERENCE } from './mock-model.ts';
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
      others: [overrides.startingCode ?? goodDrill().startingCode],
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

  it('ignores comment lines: they change no behaviour', () => {
    const solution = '// Trailing whitespace is ignored.\nexport const norm = (s: string) => s.trimEnd();\n';
    const before = solution.replace('// Trailing whitespace is ignored.', '/** Line endings are unified. */');
    assert.deepEqual(distinctiveTokens(solution, diffLines(solution, before), '//'), []);
  });

  it('matches names as written and as spoken, as whole words only', () => {
    const leaks = leakChecker(['pickNext'], ['maxBackoff', '42']);
    assert.ok(leaks('Calls pickNext to choose.'));
    assert.ok(leaks('Waits up to the max backoff.'));
    assert.ok(leaks('Gives up after 42 tries.'));
    assert.ok(!leaks('Picks the next job, 420 at most.'));
  });
});

describe('Predictions and Diagnoses', () => {
  it("take the other versions from the wrong options' Variants, and every Cause's", () => {
    const prediction = goodPrediction();
    const others = otherVersions({ kind: 'prediction', ...prediction });
    assert.equal(others.length, 3);
    assert.ok(others.includes(TS_REFERENCE.replace('job.at < best.at', 'job.at > best.at')));
    assert.equal(otherVersions({ kind: 'diagnosis', ...goodDiagnosis() }).length, 4, 'the true Cause is a Variant too: the incident');
    const names = targetNames({ referenceSolution: TS_REFERENCE, profile: TYPESCRIPT }, others.flatMap((o) => diffLines(TS_REFERENCE, o)));
    assert.deepEqual(names, ['pickNext']);
  });

  it('drop a description using a word only the true answer uses', () => {
    const prediction = answerPicker(answerTexts(goodPrediction())!);
    assert.ok(prediction('Serves the early arrivals before the rest.'), '"early" tells the true option from the others');
    assert.ok(!prediction('Holds the jobs waiting to run.'), 'job and run are in every option');
    const diagnosis = answerPicker(answerTexts(goodDiagnosis())!);
    assert.ok(diagnosis('Orders submitted work.'));
    assert.ok(!diagnosis('Orders work by priority.'), 'priority is in a wrong Cause too');
  });

  it("build the section from the Variants, and drop what picks the answer", async () => {
    const { describe: atlas, paths } = await scheduler();
    await atlas({ folder: 'The job scheduler.', file: 'The queue: early jobs go before late ones.' });
    const prediction = goodPrediction();
    const around = (kind: 'prediction' | 'diagnosis') =>
      aroundThisCode({
        paths,
        profiles: profiles(),
        profile: TYPESCRIPT,
        sourcePath: 'src/queue.ts',
        kind,
        referenceSolution: TS_REFERENCE,
        others: otherVersions({ kind: 'prediction', ...prediction }),
        answer: answerTexts(prediction)!,
      });
    const section = (await around('diagnosis'))!;
    assert.equal(section.dropped, 1);
    assert.match(section.lines.join('\n'), /The job scheduler/);
    assert.doesNotMatch(section.lines.join('\n'), /early/);

    // A Prediction's answer is behaviour, which a file's entry summarises: it is never shown.
    await atlas({ folder: 'The job scheduler.', file: 'Holds the jobs waiting to run.' });
    const lines = (await around('prediction'))!.lines.join('\n');
    assert.doesNotMatch(lines, /This file|Holds the jobs/);
    assert.match(lines, /The job scheduler/);
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

  it("uses Understand-Anything's entry when Fiu has none: marked, labelled, and through the same filter", async () => {
    const { repo, paths, around } = await scheduler();
    const { stdout: head } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const graph = (summary: string) =>
      JSON.stringify({ project: { gitCommitHash: head.trim() }, nodes: [{ id: 'file:src/queue.ts', type: 'file', filePath: 'src/queue.ts', summary }] });
    await mkdir(join(repo, '.ua'));
    await writeFile(join(repo, '.ua/knowledge-graph.json'), graph('The queue jobs wait in. Second sentence.'));
    const section = (await around())!;
    assert.ok(section.lines.includes('- **This file:** The queue jobs wait in. (UA)'));
    assert.equal(section.lines.at(-1), MODEL_WORD_UA);

    await writeFile(join(repo, '.ua/knowledge-graph.json'), graph('Holds the jobs; pickNext chooses which runs.'));
    const filtered = (await around())!;
    assert.equal(filtered.dropped, 1);
    assert.doesNotMatch(filtered.lines.join('\n'), /pickNext|This file/);

    await writeFile(paths.configFile, JSON.stringify({ understandAnything: false }));
    await writeFile(join(repo, '.ua/knowledge-graph.json'), graph('The queue jobs wait in.'));
    assert.doesNotMatch((await around())!.lines.join('\n'), /This file/);
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
    const section = await aroundThisCode({ paths, profiles: profiles(), profile: TYPESCRIPT, sourcePath: 'queue.ts', others: [goodDrill().startingCode], referenceSolution: TS_REFERENCE });
    assert.equal(section, undefined);
    assert.equal(await aroundThisCode({ paths, profiles: profiles(), profile: TYPESCRIPT, sourcePath: 'missing.ts', others: [], referenceSolution: '' }), undefined);
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
    const section = await aroundThisCode({ paths, profiles: profiles(), profile: TYPESCRIPT, sourcePath: 'a.ts', others: [goodDrill().startingCode], referenceSolution: TS_REFERENCE });
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

  it('adds it to every kind, and to none when it is off', async () => {
    const { repo, paths } = await scheduler();
    const base = { paths, profile: TYPESCRIPT, sourcePath: 'src/queue.ts', revision: await sourceRevision(repo, 'src/queue.ts'), generationAttempts: 1 };
    assert.ok((await saveDrill({ ...base, drill: goodKata(), kind: 'kata', contextProfiles: profiles() })).around);
    assert.ok((await saveDrill({ ...base, drill: goodPrediction(), kind: 'prediction', contextProfiles: profiles() })).around);
    assert.ok((await saveDrill({ ...base, drill: goodDiagnosis(), kind: 'diagnosis', contextProfiles: profiles() })).around);
    assert.equal((await saveDrill({ ...base, drill: goodDrill({ slug: 'off' }) })).around, undefined);
  });

  it("puts it before a Prediction's Scenario and a Diagnosis's incident", async () => {
    const { repo, paths } = await scheduler();
    const base = { paths, profile: TYPESCRIPT, sourcePath: 'src/queue.ts', revision: await sourceRevision(repo, 'src/queue.ts'), generationAttempts: 1, contextProfiles: profiles() };
    const prediction = await saveDrill({ ...base, drill: goodPrediction(), kind: 'prediction' });
    assert.match(await readFile(join(paths.workoutsDir, prediction.id, 'README.md'), 'utf8'), /^# Who goes first on a tie\n\n## Around this code\n[\s\S]*\n\n## Scenario\n/);
    const diagnosis = await saveDrill({ ...base, drill: goodDiagnosis(), kind: 'diagnosis' });
    assert.match(await readFile(join(paths.workoutsDir, diagnosis.id, 'README.md'), 'utf8'), /^# A later job went first\n\n\*Practice incident[^\n]*\*\n\n## Around this code\n[\s\S]*\n\n## What happened\n/);
  });

  it('is on unless the repository turns it off', () => {
    assert.equal(resolveConfig({}, {}).context, true);
    assert.equal(resolveConfig({ context: false }, {}).context, false);
  });
});
