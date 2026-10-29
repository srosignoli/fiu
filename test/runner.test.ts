import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { quick, quickWhile, train, type TrainIo, type TrainResult } from '../src/commands/train.ts';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { ignoredByWatcher, TrainingSession } from '../src/runner/session.ts';
import { watchForChanges } from '../src/runner/watch.ts';
import { openSandbox, openUnsandboxed, SandboxUnavailableError } from '../src/sandbox/sandbox.ts';
import { estimateCost } from '../src/cost/usage.ts';
import { saveDrill, sourceRevision, type Origin } from '../src/workouts/save.ts';
import { nextQuickWorkout } from '../src/workouts/queue.ts';
import type { DrillOutput } from '../src/synthesis/schema.ts';
import { openAttempt } from '../src/workouts/attempts.ts';
import { discardWorkout, listWorkouts, loadWorkout, readState, restoreWorkout, type Outcome, type StoredWorkout } from '../src/workouts/store.ts';
import { ensureWorkspace, workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';
import { goodDrill, goodKata, goodPrediction, TS_REFERENCE } from './mock-model.ts';

const sandboxWorks = await openSandbox().then(
  async (s) => (await s.dispose(), true),
  (error) => {
    if (error instanceof SandboxUnavailableError) return false;
    throw error;
  },
);

/** A repo with one committed source file and a saved Drill derived from it. */
async function repoWithDrill(slug = 'tie-breaker', kind: 'drill' | 'kata' | 'prediction' = 'drill', { bugInSource = false } = {}) {
  const repo = await tempGitRepo();
  const drill = kind === 'drill' ? goodDrill({ slug }) : kind === 'kata' ? goodKata({ slug }) : goodPrediction({ slug });
  // With bugInSource, the committed source already has the Drill's bug, and saving looks for it there.
  const source = bugInSource && 'startingCode' in drill ? drill.startingCode : TS_REFERENCE;
  await writeFile(join(repo, 'queue.ts'), source);
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
  const paths = workspacePaths(repo);
  await ensureWorkspace(paths);
  const record = await saveDrill({
    paths,
    profile: TYPESCRIPT,
    drill,
    kind,
    sourcePath: 'queue.ts',
    ...(bugInSource ? { source } : {}),
    revision: await sourceRevision(repo, 'queue.ts'),
    cost: estimateCost([{ model: 'claude-opus-5-5', inputTokens: 10_000, outputTokens: 20_000, cacheReadTokens: 0, cacheWriteTokens: 0 }]),
    generationAttempts: 1,
  });
  const dir = join(paths.workoutsDir, record.id);
  // Where the human works in Attempt n.
  const attempt = (n = 1) => join(paths.attemptsDir, record.id, String(n));
  return { repo, paths, record, dir, attempt };
}

/** A fake terminal: tests press keys and wait for output. */
class ScriptedIo implements TrainIo {
  readonly printed: string[] = [];
  readonly #keys: string[] = [];
  #keyWaiter?: (key: string | undefined) => void;
  #printWaiters: { pattern: RegExp; resolve: () => void }[] = [];
  rating: Outcome['rating'] = 'up';
  picked?: string[];

  print(text: string) {
    this.printed.push(text);
    this.#printWaiters = this.#printWaiters.filter((w) => !(w.pattern.test(text) && (w.resolve(), true)));
  }

  readKey(signal: AbortSignal): Promise<string | undefined> {
    const queued = this.#keys.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.#keyWaiter = resolve;
      signal.addEventListener('abort', () => resolve(undefined));
    });
  }

  press(key: string) {
    if (this.#keyWaiter) {
      const waiter = this.#keyWaiter;
      this.#keyWaiter = undefined;
      waiter(key);
    } else {
      this.#keys.push(key);
    }
  }

  /** Resolves once something matching `pattern` has been printed (including earlier output). */
  waitFor(pattern: RegExp): Promise<void> {
    if (this.printed.some((text) => pattern.test(text))) return Promise.resolve();
    return new Promise((resolve) => this.#printWaiters.push({ pattern, resolve }));
  }

  async pick(workouts: StoredWorkout[]) {
    this.picked = workouts.map((w) => w.record.id);
    return workouts[0];
  }

  async rate() {
    return this.rating;
  }

  defectAnswer: boolean | undefined = true;
  defectAsked = 0;
  async confirmDefect() {
    this.defectAsked++;
    return this.defectAnswer;
  }

  get transcript() {
    return this.printed.join('\n');
  }
}

function startTraining(repo: string, id: string | undefined, io: ScriptedIo): Promise<TrainResult> {
  return tempDir().then(async (cacheRoot) =>
    train(repo, id, { sandbox: sandboxWorks }, io, {
      configEnv: { env: {}, home: await tempDir() },
      cacheRoot,
      debounceMs: 20,
    }),
  );
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

describe(`kin train (${sandboxWorks ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  it('re-runs the tests on save and completes the Workout when they all pass', async () => {
    const { repo, paths, record, dir, attempt } = await repoWithDrill();
    const startingCode = await readFile(join(dir, 'kata.ts'), 'utf8');
    const io = new ScriptedIo();
    const training = startTraining(repo, record.id, io);

    await io.waitFor(/^Initial run: 2\/3 passing/);
    assert.match(io.printed[0]!, /, attempt 1\n/);
    io.press('h');
    await io.waitFor(/^Hint 1\/2: Look at how ties are broken\./);
    await writeFile(join(attempt(), 'kata.ts'), TS_REFERENCE);

    const result = await training;
    assert.equal(result.status, 'completed', io.transcript);
    assert.match(io.transcript, /Run 1: 3\/3 passing/);
    assert.match(io.transcript, /Completed\./);

    const state = await readJson(paths.stateFile);
    assert.equal(state.outcomes.length, 1);
    assert.deepEqual({ ...state.outcomes[0], at: undefined }, {
      workoutId: record.id,
      attempt: 1,
      outcome: 'completed',
      at: undefined,
      runs: 1,
      hintsUsed: 1,
      rating: 'up',
    });
    const attemptRecord = await readJson(join(attempt(), 'attempt.json'));
    assert.deepEqual([attemptRecord.outcome, attemptRecord.runs, attemptRecord.hintsUsed, attemptRecord.rating], ['completed', 1, 1, 'up']);
    // The Workout itself is untouched and stays where it is.
    assert.equal(await readFile(join(dir, 'kata.ts'), 'utf8'), startingCode);
    assert.equal(result.status === 'completed' && result.dir, attempt());
    assert.deepEqual((await listWorkouts(paths)).map((w) => w.status), ['attempted']);
  });

  it('reports a bug the source already has only after the Attempt, and asks about it once', async () => {
    const { repo, paths, record, attempt } = await repoWithDrill('tie-breaker', 'drill', { bugInSource: true });
    assert.equal(record.originalDefect?.evidence, 'source');
    const io = new ScriptedIo();
    io.defectAnswer = true;
    const training = startTraining(repo, record.id, io);
    await io.waitFor(/^Initial run/);
    assert.doesNotMatch(io.transcript, /may be real/);
    await writeFile(join(attempt(), 'kata.ts'), TS_REFERENCE);
    assert.equal((await training).status, 'completed', io.transcript);

    assert.match(io.transcript, /Completed\. Well mended\.\n⚠ This bug may be real: queue\.ts:\d+ has the same logic as this Workout's bug \(Workout made from commit [0-9a-f]{12}\)\.\n {2}The tie-breaker compares/);
    assert.equal(io.defectAsked, 1);
    assert.equal((await readJson(join(attempt(), 'attempt.json'))).defectConfirmed, true);
    assert.equal((await readJson(paths.stateFile)).outcomes[0].defectConfirmed, true);

    // A second Attempt shows the notice again but doesn't ask again.
    const again = new ScriptedIo();
    const second = startTraining(repo, record.id, again);
    await again.waitFor(/^Initial run/);
    await writeFile(join(attempt(2), 'kata.ts'), TS_REFERENCE);
    assert.equal((await second).status, 'completed', again.transcript);
    assert.match(again.transcript, /may be real/);
    assert.equal(again.defectAsked, 0);
    assert.equal((await readJson(join(attempt(2), 'attempt.json'))).defectConfirmed, undefined);
  });

  describe('a Prediction', () => {
    /** The key that picks the option with this text, in this Attempt's shuffled order. */
    const keyFor = (io: ScriptedIo, text: string) => io.printed[0]!.match(new RegExp(`\\[(\\d)\\] ${text.replace(/[."]/g, '\\$&')}`))![1]!;

    it('completes on the right answer, with no tests run and no code to edit', async () => {
      const { repo, paths, record, attempt } = await repoWithDrill('tied-priorities', 'prediction');
      // Every Prediction is Quick, whatever the length of the code behind it.
      assert.equal((await nextQuickWorkout(paths))?.record.id, record.id);
      const io = new ScriptedIo();
      const training = startTraining(repo, record.id, io);
      await io.waitFor(/\[1\]-\[4\] answer/);
      assert.match(io.printed[0]!, /attempt 1\n\nThree jobs are waiting\./);
      assert.doesNotMatch(io.transcript, /Initial run|Incident report/);
      io.press(keyFor(io, 'The "early" job runs next.'));

      const result = await training;
      assert.equal(result.status, 'completed', io.transcript);
      assert.match(io.transcript, /Right: The "early" job runs next\.\n\nThe highest priority wins.*\n\nWhere this lives:\n {2}queue\.ts:3-9: The scheduler picks/);
      const saved = await readJson(join(attempt(), 'attempt.json'));
      assert.equal(saved.answer, 0);
      assert.deepEqual([...saved.order].sort(), [0, 1, 2, 3]);
      assert.equal(existsSync(join(attempt(), 'kata.ts')), false);
      assert.equal((await readJson(paths.stateFile)).outcomes[0].outcome, 'completed');
    });

    it('abandons on a wrong answer, explaining the misunderstanding and the code behind it', async () => {
      const { repo, record, attempt } = await repoWithDrill('tied-priorities', 'prediction');
      const io = new ScriptedIo();
      const training = startTraining(repo, record.id, io);
      await io.waitFor(/\[1\]-\[4\] answer/);
      io.press(keyFor(io, 'The "late" job runs next.'));
      await io.waitFor(/^\[d\] the code difference/);
      io.press('d');

      assert.equal((await training).status, 'abandoned', io.transcript);
      assert.match(io.transcript, /Not quite\. What happens: The "early" job runs next\.\nYou were picturing a system where the newest job wins a tie\./);
      assert.match(io.transcript, /the code would change like this:\n@@ line 6 @@\n- .*job\.at < best\.at.*\n\+ .*job\.at > best\.at/);
      assert.equal((await readJson(join(attempt(), 'attempt.json'))).answer, 1);
    });

    it('leaves the Attempt open on [q], keeping its order for the resume', async () => {
      const { repo, record, attempt } = await repoWithDrill('tied-priorities', 'prediction');
      const io = new ScriptedIo();
      const training = startTraining(repo, record.id, io);
      await io.waitFor(/\[1\]-\[4\] answer/);
      io.press('9');
      io.press('q');
      assert.equal((await training).status, 'left-pending');
      const { order } = await readJson(join(attempt(), 'attempt.json'));

      const again = new ScriptedIo();
      const resumed = startTraining(repo, record.id, again);
      await again.waitFor(/\[1\]-\[4\] answer/);
      assert.match(again.printed[0]!, /attempt 1, resumed/);
      assert.deepEqual((await readJson(join(attempt(), 'attempt.json'))).order, order);
      again.press('q');
      await resumed;
    });
  });

  it('heads a Kata with its brief and the file to fill in', async () => {
    const { repo, record, attempt } = await repoWithDrill('pick-next', 'kata');
    const io = new ScriptedIo();
    const training = startTraining(repo, record.id, io);
    await io.waitFor(/^Initial run: 1\/3 passing/);
    assert.match(io.printed[0]!, /\n {2}Brief: +\S+README\.md\n {2}Fill in: +\S+kata\.ts/);
    assert.doesNotMatch(io.printed[0]!, /Incident report|Fix the bug/);
    await writeFile(join(attempt(), 'kata.ts'), TS_REFERENCE);
    assert.equal((await training).status, 'completed', io.transcript);
  });

  it('shows failing tests with their output, and ignores saves that change nothing', async () => {
    const { repo, record, attempt } = await repoWithDrill();
    const io = new ScriptedIo();
    const training = startTraining(repo, record.id, io);

    await io.waitFor(/^Initial run/);
    assert.match(io.printed.find((t) => t.startsWith('Initial run'))!, /✗ pickNext > serves equal priorities first come, first served/);
    // Same content: no run. Then a real change.
    const code = join(attempt(), 'kata.ts');
    await writeFile(code, await readFile(code, 'utf8'));
    // Kintsugi's own bookkeeping file never triggers a run.
    const bookkeeping = join(attempt(), 'attempt.json');
    await writeFile(bookkeeping, await readFile(bookkeeping, 'utf8'));
    await writeFile(code, `${await readFile(code, 'utf8')}\n// still buggy\n`);
    await io.waitFor(/^Run 1:/);
    io.press('q');

    const result = await training;
    assert.deepEqual(result, { status: 'left-pending', workoutId: record.id, attempt: 1 });
    assert.equal(io.printed.filter((t) => /^Run \d/.test(t)).length, 1);
    assert.match(io.transcript, /Attempt 1 left open\. Resume with: kin train/);
  });

  it('abandons the Workout on give-up, showing what the solution changes', async () => {
    const { repo, paths, record } = await repoWithDrill();
    const io = new ScriptedIo();
    io.rating = undefined;
    const training = startTraining(repo, record.id, io);
    await io.waitFor(/^Initial run/);
    io.press('g');

    const result = await training;
    assert.equal(result.status, 'abandoned');
    assert.match(io.transcript, /@@ line \d+ @@\n- .*job\.at > best\.at.*\n\+ .*job\.at < best\.at/);
    const [outcome] = (await readJson(paths.stateFile)).outcomes;
    assert.equal(outcome.outcome, 'abandoned');
    assert.equal(outcome.rating, undefined);
  });

  it('does not count passing edited tests as Completed', async () => {
    const { repo, record, attempt } = await repoWithDrill();
    const io = new ScriptedIo();
    const training = startTraining(repo, record.id, io);
    await io.waitFor(/^Initial run/);
    const tests = await readFile(join(attempt(), 'kata.test.ts'), 'utf8');
    // Make the Regression Test expect the buggy behaviour.
    await writeFile(join(attempt(), 'kata.test.ts'), tests.replace("]), 'early')", "]), 'late')"));
    await io.waitFor(/the test file was edited/);
    io.press('q');
    assert.equal((await training).status, 'left-pending');
  });

  it('warns when the source has changed since the Workout was made', async () => {
    const { repo, record } = await repoWithDrill();
    await writeFile(join(repo, 'queue.ts'), '// rewritten\n');
    const io = new ScriptedIo();
    const training = startTraining(repo, record.id, io);
    await io.waitFor(/^Initial run/);
    io.press('q');
    await training;
    assert.match(io.transcript, /Source has changed since this Workout was made\./);
  });

  it('picks among pending Workouts, or reports that there are none', async () => {
    const { repo, record } = await repoWithDrill('first');
    const second = await saveDrill({
      paths: workspacePaths(repo),
      profile: TYPESCRIPT,
      drill: goodDrill({ slug: 'second' }),
      sourcePath: 'queue.ts',
      revision: { dirty: false },
      cost: estimateCost([]),
      generationAttempts: 1,
      now: new Date(Date.now() + 1000),
    });
    const io = new ScriptedIo();
    io.press('q');
    await startTraining(repo, undefined, io);
    assert.deepEqual(io.picked, [second.id, record.id], 'newest first');

    const empty = await tempGitRepo();
    assert.deepEqual(await startTraining(empty, undefined, new ScriptedIo()), { status: 'nothing-pending' });
    await assert.rejects(startTraining(repo, 'drill_nope', new ScriptedIo()), /No Workout "drill_nope"/);
  });
});

describe(`Attempts (${sandboxWorks ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  it('resume an open Attempt with its code, runs, and Hints', async () => {
    const { repo, record, attempt } = await repoWithDrill();
    const first = new ScriptedIo();
    const training = startTraining(repo, record.id, first);
    await first.waitFor(/^Initial run/);
    first.press('h');
    await first.waitFor(/^Hint 1\/2/);
    await writeFile(join(attempt(), 'kata.ts'), `${await readFile(join(attempt(), 'kata.ts'), 'utf8')}\n// my notes\n`);
    await first.waitFor(/^Run 1:/);
    first.press('q');
    await training;

    const second = new ScriptedIo();
    const resumed = startTraining(repo, record.id, second);
    await second.waitFor(/^Initial run/);
    assert.match(second.printed[0]!, /, attempt 1, resumed\n/);
    second.press('h');
    await second.waitFor(/^Hint 2\/2/);
    await writeFile(join(attempt(), 'kata.ts'), TS_REFERENCE);
    const result = await resumed;
    assert.equal(result.status, 'completed');
    const done = await readJson(join(attempt(), 'attempt.json'));
    assert.deepEqual([done.runs, done.hintsUsed], [2, 2]);
  });

  it('redo a finished Workout in a fresh Attempt from the original Starting Code', async () => {
    const { repo, paths, record, dir, attempt } = await repoWithDrill();
    const io = new ScriptedIo();
    const training = startTraining(repo, record.id, io);
    await io.waitFor(/^Initial run/);
    io.press('g');
    await training;

    const redo = new ScriptedIo();
    const again = startTraining(repo, record.id, redo);
    await redo.waitFor(/^Initial run: 2\/3 passing/);
    assert.match(redo.printed[0]!, /, attempt 2\n/);
    assert.equal(await readFile(join(attempt(2), 'kata.ts'), 'utf8'), await readFile(join(dir, 'kata.ts'), 'utf8'));
    redo.press('q');
    await again;
    assert.deepEqual((await listWorkouts(paths)).map((w) => w.status), ['in-progress']);
    assert.deepEqual((await readState(paths)).outcomes.map((o) => [o.attempt, o.outcome]), [[1, 'abandoned']]);
  });

  it('list open Attempts before the queue, and leave Discarded Workouts out', async () => {
    const { repo, paths, record } = await repoWithDrill('older');
    const newer = await saveDrill({
      paths,
      profile: TYPESCRIPT,
      drill: goodDrill({ slug: 'newer' }),
      sourcePath: 'queue.ts',
      revision: { dirty: false },
      generationAttempts: 1,
      now: new Date(Date.now() + 1000),
    });
    const third = await saveDrill({
      paths,
      profile: TYPESCRIPT,
      drill: goodDrill({ slug: 'third' }),
      sourcePath: 'queue.ts',
      revision: { dirty: false },
      generationAttempts: 1,
      now: new Date(Date.now() + 2000),
    });
    await openAttempt(paths, { record, dir: join(paths.workoutsDir, record.id) }, TYPESCRIPT);
    await discardWorkout(paths, third.id, 'manual');

    const io = new ScriptedIo();
    io.press('q');
    await startTraining(repo, undefined, io);
    assert.deepEqual(io.picked, [record.id, newer.id]);
    await assert.rejects(startTraining(repo, third.id, new ScriptedIo()), /is discarded\. Bring it back with `kin restore/);

    await restoreWorkout(paths, third.id);
    assert.equal((await listWorkouts(paths)).find((w) => w.record.id === third.id)?.status, 'queued');
  });

  it('read outcomes recorded by v1', async () => {
    const { paths } = await repoWithDrill();
    await writeFile(
      paths.stateFile,
      JSON.stringify({ outcomes: [{ workoutId: 'drill_old', outcome: 'completed', at: new Date().toISOString(), attempts: 3, hintsUsed: 0 }] }),
    );
    const [outcome] = (await readState(paths)).outcomes;
    assert.deepEqual([outcome!.runs, outcome!.attempt], [3, undefined]);
  });
});

describe('TrainingSession', () => {
  it('reveals each Hint once, then reports there are none left', async () => {
    const { paths, record, dir } = await repoWithDrill();
    const workout = { record, dir };
    const { attempt } = await openAttempt(paths, workout, TYPESCRIPT);
    const session = new TrainingSession({ paths, workout, attempt, profile: TYPESCRIPT, sandbox: openUnsandboxed() });
    assert.equal((await session.nextHint())?.number, 1);
    assert.equal((await session.nextHint())?.number, 2);
    assert.equal(await session.nextHint(), undefined);
    assert.equal(session.hintsUsed, 2);
  });
});

describe('watchForChanges', () => {
  it('fires on content changes only, outside ignored paths', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'kata.ts'), 'a');
    let changes = 0;
    const watcher = await watchForChanges(dir, () => changes++, { ignore: ignoredByWatcher(TYPESCRIPT), debounceMs: 20 });
    const settle = () => new Promise((r) => setTimeout(r, 150));
    try {
      await writeFile(join(dir, 'kata.ts'), 'a');
      await writeFile(join(dir, 'attempt.json'), '{}');
      await writeFile(join(dir, 'kata.ts.swp'), 'x');
      await settle();
      assert.equal(changes, 0);
      await writeFile(join(dir, 'kata.ts'), 'b');
      await settle();
      assert.equal(changes, 1);
    } finally {
      watcher.close();
    }
  });
});

describe(`kin quick (${sandboxWorks ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  /** Saves a Drill into an existing repo; `seconds` orders them by creation time. */
  async function addDrill(repo: string, slug: string, seconds: number, overrides: Partial<DrillOutput> = {}, origin: Origin = 'manual') {
    return saveDrill({
      paths: workspacePaths(repo),
      profile: TYPESCRIPT,
      drill: goodDrill({ slug, estimatedMinutes: 4, ...overrides }),
      sourcePath: 'queue.ts',
      revision: { dirty: false },
      generationAttempts: 1,
      origin,
      now: new Date(Date.now() + seconds * 1000),
    });
  }

  it('picks the queue’s best Quick Workout: from AI-written code first, then the newest', async () => {
    const { repo, paths, record } = await repoWithDrill('oldest');
    assert.equal(record.estimatedMinutes, 5, 'goodDrill takes 5 minutes, which is still Quick');
    await addDrill(repo, 'too-long-to-solve', 1, { estimatedMinutes: 9 });
    await addDrill(repo, 'too-much-code', 2, { startingCode: `${'// filler\n'.repeat(60)}${TS_REFERENCE}` });
    const agentTask = await addDrill(repo, 'from-agent-task', 3, {}, 'agent-task');
    const newest = await addDrill(repo, 'newest-manual', 4);

    assert.equal((await nextQuickWorkout(paths))?.record.id, agentTask.id);
    await discardWorkout(paths, agentTask.id, 'manual');
    assert.equal((await nextQuickWorkout(paths))?.record.id, newest.id);
    await openAttempt(paths, await loadWorkout(paths, newest.id), TYPESCRIPT);
    assert.equal((await nextQuickWorkout(paths))?.record.id, record.id, 'attempted Workouts leave the queue');
  });

  it('serves the preferred kinds first, falling back to the others rather than to nothing', async () => {
    const { paths, record: drill } = await repoWithDrill('a-drill');
    const prediction = await saveDrill({
      paths,
      profile: TYPESCRIPT,
      drill: goodPrediction(),
      kind: 'prediction',
      sourcePath: 'queue.ts',
      revision: { dirty: false },
      generationAttempts: 1,
      now: new Date(Date.now() - 60_000),
    });
    // The Drill is newer, so it wins by default; preferring Predictions puts the older one first.
    assert.equal((await nextQuickWorkout(paths))?.record.id, drill.id);
    assert.equal((await nextQuickWorkout(paths, ['prediction']))?.record.id, prediction.id);
    await openAttempt(paths, await loadWorkout(paths, prediction.id), TYPESCRIPT);
    assert.equal((await nextQuickWorkout(paths, ['prediction']))?.record.id, drill.id, 'a preference, not a filter');
  });

  it('skips Workouts whose source file is gone', async () => {
    const { repo, paths } = await repoWithDrill();
    await rm(join(repo, 'queue.ts'));
    assert.equal(await nextQuickWorkout(paths), undefined);
  });

  it('opens the runner straight away, or says nothing is ready', async () => {
    const { repo, record } = await repoWithDrill();
    const io = new ScriptedIo();
    const run = (target: string) =>
      tempDir().then(async (cacheRoot) => quick(target, { sandbox: sandboxWorks }, io, { configEnv: { env: {}, home: await tempDir() }, cacheRoot, debounceMs: 20 }));
    const session = run(repo);
    await io.waitFor(/^Initial run/);
    assert.equal(io.picked, undefined, 'no picker');
    assert.match(io.printed[0]!, new RegExp(`^${record.title} \\(${record.id}\\), attempt 1`));
    io.press('q');
    await session;
    assert.deepEqual(await run(repo), { status: 'nothing-ready' }, 'the Workout now has an Attempt, so the queue is empty');
  });

  describe('--while', () => {
    /** A command that waits for the test to let it finish, then exits with `exitCode`. */
    async function gatedCommand(exitCode = 0) {
      const flag = join(await tempDir(), 'go');
      return { command: `echo building; while [ ! -f ${flag} ]; do sleep 0.05; done; echo built; exit ${exitCode}`, release: () => writeFile(flag, '') };
    }
    const runWhile = (repo: string, command: string, io: ScriptedIo) =>
      tempDir().then(async (cacheRoot) =>
        quickWhile(repo, command, { sandbox: sandboxWorks }, io, { configEnv: { env: {}, home: await tempDir() }, cacheRoot, debounceMs: 20, shell: '/bin/sh' }),
      );

    it('serves a Quick Workout while the command runs, and announces the moment it ends', async () => {
      const { repo, paths, attempt } = await repoWithDrill();
      const { command, release } = await gatedCommand();
      const io = new ScriptedIo();
      const running = runWhile(repo, command, io);

      await io.waitFor(/^Initial run/);
      assert.match(io.printed[0]!, new RegExp(`^Running \`echo building;.*\` in the background\\. Log: ${join(paths.root, 'while', 'last.log')}$`));
      assert.match(io.transcript, /\[q\] quit {3}\[s\] `echo building;/);
      io.press('s');
      await io.waitFor(/running for \d+s\n {2}│ building$/);

      await release();
      await io.waitFor(/^\x07✓ `echo building;.*` finished in \d+s/);
      // The Workout carries on after the command ends.
      await writeFile(join(attempt(), 'kata.ts'), TS_REFERENCE);
      const result = await running;
      assert.equal(result.status === 'ran' && result.result.exitCode, 0);
      assert.match(io.transcript, /Completed\./);
      assert.doesNotMatch(io.transcript, /Another Quick Workout|Waiting for/);
      assert.equal(io.printed.filter((t) => /finished in/.test(t)).length, 1, 'announced once');
    });

    it('offers another Quick Workout, then waits for the command and reports its failure', async () => {
      const { repo, attempt, record } = await repoWithDrill('first');
      const second = await addDrill(repo, 'second', 10);
      const { command, release } = await gatedCommand(3);
      const io = new ScriptedIo();
      const running = runWhile(repo, command, io);

      await io.waitFor(new RegExp(`^${second.title} \\(${second.id}\\)`));
      await io.waitFor(/^Initial run/);
      io.press('q');
      await io.waitFor(/^Another Quick Workout while `echo building;.*` runs\? \[y\]/);
      io.press('y');
      await io.waitFor(new RegExp(`^${record.title} \\(${record.id}\\)`));
      await writeFile(join(attempt(), 'kata.ts'), TS_REFERENCE);
      await io.waitFor(/^Waiting for `echo building;.*`\. \[q\] stop it$/);

      await release();
      const result = await running;
      assert.equal(result.status === 'ran' && result.result.exitCode, 3);
      assert.match(io.transcript, /✗ `echo building;.*` failed \(exit 3\) after \d+s\n {2}│ building\n {2}│ built\nLog: /);
    });

    it('stops the command on [q] while waiting for it', async () => {
      const { repo } = await repoWithDrill();
      const io = new ScriptedIo();
      const running = runWhile(repo, 'sleep 30', io);
      await io.waitFor(/^Initial run/);
      io.press('q');
      await io.waitFor(/^Waiting for `sleep 30`/);
      io.press('q');
      const result = await running;
      assert.equal(result.status === 'ran' && result.result.exitCode, 130);
      assert.match(io.transcript, /✗ `sleep 30` was stopped \(SIGINT\)/);
    });

    it('starts nothing when no Quick Workout is ready', async () => {
      const { repo, paths } = await repoWithDrill();
      await discardWorkout(paths, (await nextQuickWorkout(paths))!.record.id, 'manual');
      assert.deepEqual(await runWhile(repo, 'touch should-not-exist', new ScriptedIo()), { status: 'nothing-ready' });
      assert.equal(existsSync(join(repo, 'should-not-exist')), false);
      assert.equal(existsSync(join(paths.root, 'while')), false);
    });
  });
});
