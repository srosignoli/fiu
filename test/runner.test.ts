import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { train, type TrainIo, type TrainResult } from '../src/commands/train.ts';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { ignoredByWatcher, TrainingSession } from '../src/runner/session.ts';
import { watchForChanges } from '../src/runner/watch.ts';
import { openSandbox, openUnsandboxed, SandboxUnavailableError } from '../src/sandbox/sandbox.ts';
import { saveDrill, sourceRevision } from '../src/workouts/save.ts';
import { listPending, type Outcome, type PendingWorkout } from '../src/workouts/store.ts';
import { ensureWorkspace, workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';
import { goodDrill, TS_REFERENCE } from './mock-model.ts';

const sandboxWorks = await openSandbox().then(
  async (s) => (await s.dispose(), true),
  (error) => {
    if (error instanceof SandboxUnavailableError) return false;
    throw error;
  },
);

/** A repo with one committed source file and a saved Drill derived from it. */
async function repoWithDrill(slug = 'tie-breaker') {
  const repo = await tempGitRepo();
  await writeFile(join(repo, 'queue.ts'), TS_REFERENCE);
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
  const paths = workspacePaths(repo);
  await ensureWorkspace(paths);
  const record = await saveDrill({
    paths,
    profile: TYPESCRIPT,
    drill: goodDrill({ slug }),
    sourcePath: 'queue.ts',
    revision: await sourceRevision(repo, 'queue.ts'),
  });
  return { repo, paths, record, dir: join(paths.workoutsDir, record.id) };
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

  async pick(workouts: PendingWorkout[]) {
    this.picked = workouts.map((w) => w.record.id);
    return workouts[0];
  }

  async rate() {
    return this.rating;
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
    const { repo, paths, record, dir } = await repoWithDrill();
    const io = new ScriptedIo();
    const training = startTraining(repo, record.id, io);

    await io.waitFor(/^Initial run: 2\/3 passing/);
    io.press('h');
    await io.waitFor(/^Hint 1\/2: Look at how ties are broken\./);
    await writeFile(join(dir, 'kata.ts'), TS_REFERENCE);

    const result = await training;
    assert.equal(result.status, 'completed', io.transcript);
    assert.match(io.transcript, /Run 1: 3\/3 passing/);
    assert.match(io.transcript, /Completed\./);

    const state = await readJson(paths.stateFile);
    assert.equal(state.outcomes.length, 1);
    assert.deepEqual({ ...state.outcomes[0], at: undefined }, {
      workoutId: record.id,
      outcome: 'completed',
      at: undefined,
      attempts: 1,
      hintsUsed: 1,
      rating: 'up',
    });
    assert.ok(!existsSync(dir));
    assert.ok(existsSync(join(paths.doneDir, record.id, 'workout.json')));
    assert.deepEqual(await listPending(paths), []);
  });

  it('shows failing tests with their output, and ignores saves that change nothing', async () => {
    const { repo, record, dir } = await repoWithDrill();
    const io = new ScriptedIo();
    const training = startTraining(repo, record.id, io);

    await io.waitFor(/^Initial run/);
    assert.match(io.printed.find((t) => t.startsWith('Initial run'))!, /✗ pickNext > serves equal priorities first come, first served/);
    // Same content: no run. Then a real change.
    await writeFile(join(dir, 'kata.ts'), await readFile(join(dir, 'kata.ts'), 'utf8'));
    await writeFile(join(dir, 'README.md'), 'notes');
    await writeFile(join(dir, 'kata.ts'), `${await readFile(join(dir, 'kata.ts'), 'utf8')}\n// still buggy\n`);
    await io.waitFor(/^Run 1:/);
    io.press('q');

    const result = await training;
    assert.deepEqual(result, { status: 'left-pending', workoutId: record.id });
    assert.equal(io.printed.filter((t) => /^Run \d/.test(t)).length, 1);
    assert.match(io.transcript, /Left pending\. Resume with: kin train/);
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
    const { repo, record, dir } = await repoWithDrill();
    const io = new ScriptedIo();
    const training = startTraining(repo, record.id, io);
    await io.waitFor(/^Initial run/);
    const tests = await readFile(join(dir, 'kata.test.ts'), 'utf8');
    // Make the Regression Test expect the buggy behaviour.
    await writeFile(join(dir, 'kata.test.ts'), tests.replace("]), 'early')", "]), 'late')"));
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
      now: new Date(Date.now() + 1000),
    });
    const io = new ScriptedIo();
    io.press('q');
    await startTraining(repo, undefined, io);
    assert.deepEqual(io.picked, [second.id, record.id], 'newest first');

    const empty = await tempGitRepo();
    assert.deepEqual(await startTraining(empty, undefined, new ScriptedIo()), { status: 'nothing-pending' });
    await assert.rejects(startTraining(repo, 'drill_nope', new ScriptedIo()), /No pending Workout "drill_nope"/);
  });
});

describe('TrainingSession', () => {
  it('reveals each Hint once, then reports there are none left', async () => {
    const { paths, record, dir } = await repoWithDrill();
    const session = new TrainingSession({ paths, workout: { record, dir }, profile: TYPESCRIPT, sandbox: openUnsandboxed() });
    assert.equal(session.nextHint()?.number, 1);
    assert.equal(session.nextHint()?.number, 2);
    assert.equal(session.nextHint(), undefined);
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
      await writeFile(join(dir, 'README.md'), 'notes');
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
