import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { chooseTarget, isAiAuthored } from '../src/background/commits.ts';
import { readLog, unseenFailureSummary } from '../src/background/log.ts';
import { expireStaleWorkouts, refill, RefillBusyError, type RefillOptions } from '../src/background/refill.ts';
import { profiles } from '../src/languages/registry.ts';
import { openSandbox, SandboxUnavailableError } from '../src/sandbox/sandbox.ts';
import type { AnyWorkoutOutput } from '../src/synthesis/schema.ts';
import { listWorkouts, readState } from '../src/workouts/store.ts';
import { nextQuickWorkout } from '../src/workouts/queue.ts';
import { workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';
import { goodCommitPrediction, goodDrill, scriptedModel, TS_BEFORE_COMMIT, TS_REFERENCE } from './mock-model.ts';

const sandboxWorks = await openSandbox().then(
  async (s) => (await s.dispose(), true),
  (error) => {
    if (error instanceof SandboxUnavailableError) return false;
    throw error;
  },
);

const ME = 'me@example.com';

async function git(repo: string, ...args: string[]) {
  return (await execa('git', args, { cwd: repo })).stdout;
}

/** Commits files as the given author (you, by default), with an optional trailer. */
async function commit(repo: string, files: Record<string, string>, { author = ME, trailer = '', message = 'change' } = {}): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(repo, name, '..'), { recursive: true });
    await writeFile(join(repo, name), content);
  }
  await git(repo, 'add', '.');
  await git(repo, '-c', `user.name=x`, '-c', `user.email=${author}`, 'commit', '-qm', trailer ? `${message}\n\n${trailer}` : message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A repository whose latest commit rewrites src/queue.ts. */
async function repoWithChange(trailer = ''): Promise<{ repo: string; sha: string }> {
  const repo = await tempGitRepo();
  await git(repo, 'config', 'user.email', ME);
  await commit(repo, { 'src/queue.ts': 'export const placeholder = 1;\n' });
  const sha = await commit(repo, { 'src/queue.ts': TS_REFERENCE }, { trailer, message: 'Schedule jobs by priority' });
  return { repo, sha };
}

async function configure(repo: string, config: Record<string, unknown>) {
  await mkdir(join(repo, '.fiutsu'), { recursive: true });
  await writeFile(join(repo, '.fiutsu', 'config.json'), JSON.stringify(config));
}
const backgroundReady = { consent: { provider: 'anthropic', grantedAt: new Date().toISOString() }, auto: { enabled: true } };

async function run(repo: string, options: Partial<RefillOptions>, replies: (Partial<AnyWorkoutOutput> | string)[] = [goodDrill()], env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'k' }) {
  const scripted = scriptedModel(...replies);
  const result = await refill(
    repo,
    { background: false, yes: true, sandbox: sandboxWorks, ...options },
    { step: () => {}, warn: () => {} },
    {
      createModel: () => ({ model: scripted.model, providerOptions: {} }),
      configEnv: { env, home: await tempDir() },
      cacheRoot: await tempDir(),
    },
  );
  return { ...result, prompts: scripted.prompts };
}

const outcomes = (r: Awaited<ReturnType<typeof run>>) => r.outcomes.map((o) => [o.outcome, o.reason ?? o.workoutId]);

describe('commit selection', () => {
  it('recognises AI co-author trailers', () => {
    assert.equal(isAiAuthored('Fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'), true);
    assert.equal(isAiAuthored('Fix\n\nCo-authored-by: Copilot <copilot@github.com>'), true);
    assert.equal(isAiAuthored('Fix\n\nCo-Authored-By: Ada Lovelace <ada@example.com>'), false);
    assert.equal(isAiAuthored('Mention claude in the subject only'), false);
  });

  it('picks the most-changed source file, ignoring tests, generated code, and docs', async () => {
    const repo = await tempGitRepo();
    await commit(repo, { 'README.md': 'x' });
    const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
    const sha = await commit(repo, {
      'src/small.ts': lines(6, 's'),
      'src/big.ts': lines(12, 'b'),
      'src/big.test.ts': lines(40, 't'),
      'dist/bundle.js': lines(50, 'd'),
      'docs/guide.md': lines(60, 'm'),
    });
    const choice = await chooseTarget(repo, sha, profiles());
    assert.ok('target' in choice);
    assert.equal(choice.target.path, 'src/big.ts');
    assert.equal(choice.target.changedLines, 12);
    assert.match(choice.target.diff, /^\+export const b11 = 11;$/m);
  });

  it('skips commits with nothing worth drilling', async () => {
    const repo = await tempGitRepo();
    const docs = await commit(repo, { 'README.md': 'docs only\n' });
    const docsChoice = await chooseTarget(repo, docs, profiles());
    assert.ok('skip' in docsChoice && /no changed source file/.test(docsChoice.skip));
    const tiny = await commit(repo, { 'src/a.ts': 'export const a = 1;\n' });
    const tinyChoice = await chooseTarget(repo, tiny, profiles());
    assert.ok('skip' in tinyChoice && /too small to drill \(1 changed lines/.test(tinyChoice.skip));
    const bulk = await commit(repo, { 'src/huge.ts': Array.from({ length: 301 }, (_, i) => `export const h${i} = ${i};`).join('\n') + '\n' });
    const bulkChoice = await chooseTarget(repo, bulk, profiles());
    assert.ok('skip' in bulkChoice && /too large to be one focused change \(301 changed lines in src\/huge\.ts\)/.test(bulkChoice.skip));
  });
});

describe(`fiu refill (${sandboxWorks ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  it('turns the latest commit into a Quick Drill built around its change', async () => {
    const { repo, sha } = await repoWithChange('Co-Authored-By: Claude <noreply@anthropic.com>');
    const result = await run(repo, {});
    assert.deepEqual(result.outcomes.map((o) => o.outcome), ['generated']);
    assert.match(result.prompts[0]!, /This file was just changed by commit [0-9a-f]{12} \(\\"Schedule jobs by priority\\"\)/);
    assert.match(result.prompts[0]!, /<diff>/);
    assert.match(result.prompts[0]!, /This is a Quick Drill/);

    const paths = workspacePaths(repo);
    const [workout] = await listWorkouts(paths);
    assert.equal(workout!.record.origin, 'commit');
    assert.deepEqual(workout!.record.commit, { sha, aiAuthored: true, subject: 'Schedule jobs by priority' });
    assert.equal(workout!.record.sourceAnchors[0]!.commit, sha);
    const state = await readState(paths);
    assert.deepEqual([state.spend[0]!.origin, state.spend[0]!.result], ['commit', 'verified']);
    assert.deepEqual(state.refill.processed, [sha]);
    assert.equal((await readLog(paths))[0]!.outcome, 'generated');

    assert.deepEqual(outcomes(await run(repo, {})), [['skipped', 'already processed']], 'never pay twice for one commit');
  });

  it('skips merges and other authors before any LLM call', async () => {
    const { repo } = await repoWithChange();
    await git(repo, 'checkout', '-qb', 'side');
    await commit(repo, { 'src/side.ts': TS_REFERENCE });
    await git(repo, 'checkout', '-q', '-');
    await commit(repo, { 'src/main.ts': TS_REFERENCE });
    await git(repo, '-c', `user.email=${ME}`, '-c', 'user.name=x', 'merge', '-q', '--no-ff', '-m', 'merge', 'side');
    const merge = await run(repo, {});
    assert.deepEqual(outcomes(merge), [['skipped', 'merge commit']]);
    assert.equal(merge.prompts.length, 0);

    await commit(repo, { 'src/theirs.ts': TS_REFERENCE }, { author: 'someone@else.dev' });
    assert.deepEqual(outcomes(await run(repo, {})), [['skipped', 'authored by someone@else.dev, not you']]);
  });

  it('runs in the background only when turned on, consented, and keyed: otherwise it logs and stops', async () => {
    const { repo } = await repoWithChange();
    const off = await run(repo, { background: true });
    assert.match(off.outcomes[0]!.reason!, /background generation is off/);
    await configure(repo, { auto: { enabled: true } });
    assert.match((await run(repo, { background: true })).outcomes[0]!.reason!, /no consent to send code to anthropic/);
    await configure(repo, backgroundReady);
    assert.match((await run(repo, { background: true }, undefined, {})).outcomes[0]!.reason!, /no API key/);
    const ready = await run(repo, { background: true });
    assert.deepEqual(ready.outcomes.map((o) => o.outcome), ['generated']);
  });

  it('defers when the queue is full or today’s generations are used up, without marking the commit processed', async () => {
    const { repo, sha } = await repoWithChange();
    await configure(repo, { ...backgroundReady, auto: { enabled: true, queueCap: 1, dailyLimit: 2 } });
    const paths = workspacePaths(repo);
    // Something already waiting in the queue.
    await commit(repo, { 'src/other.ts': TS_REFERENCE });
    await run(repo, { commit: 'HEAD' });
    const full = await run(repo, { background: true, commit: sha });
    assert.deepEqual(outcomes(full), [['deferred', 'the queue already holds 1 Workouts (cap 1)']]);
    assert.ok(!(await readState(paths)).refill.processed.includes(sha));

    // The earlier foreground generation used 1 of today's 2; a failing Drill may then try only once more.
    await configure(repo, { ...backgroundReady, auto: { enabled: true, queueCap: 5, dailyLimit: 2 } });
    const limited = await run(repo, { background: true, commit: sha }, [goodDrill({ startingCode: TS_REFERENCE })]);
    assert.deepEqual(limited.outcomes.map((o) => o.outcome), ['failed']);
    assert.equal(limited.prompts.length, 1);
    const blocked = await run(repo, { background: true, commit: await commit(repo, { 'src/third.ts': TS_REFERENCE }) });
    assert.deepEqual(outcomes(blocked), [['deferred', "today's limit of 2 generations is used up"]]);
  });

  it('allows one generator at a time: background commits wait in the backlog, then run newest first', async () => {
    const { repo, sha } = await repoWithChange();
    await configure(repo, backgroundReady);
    const paths = workspacePaths(repo);
    const lock = join(paths.root, 'refill.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    assert.deepEqual(outcomes(await run(repo, { background: true })), [['deferred', 'another generator is running; queued in the backlog']]);
    await assert.rejects(run(repo, {}), RefillBusyError);

    const second = await commit(repo, { 'src/second.ts': TS_REFERENCE });
    await run(repo, { background: true });
    assert.deepEqual((await readState(paths)).refill.backlog.map((b) => b.sha), [sha, second]);

    // A dead holder's lock is taken over; the run then drains the backlog.
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, at: new Date().toISOString() }));
    const third = await commit(repo, { 'src/third.ts': TS_REFERENCE });
    const drained = await run(repo, { background: true }, [goodDrill({ slug: 'a' }), goodDrill({ slug: 'b' }), goodDrill({ slug: 'c' })]);
    assert.deepEqual(drained.outcomes.map((o) => o.commit), [third, second, sha]);
    assert.deepEqual((await readState(paths)).refill.backlog, []);
  });

  it('never queues two commit Drills for the same file', async () => {
    const { repo } = await repoWithChange();
    await run(repo, {});
    await commit(repo, { 'src/queue.ts': `${TS_REFERENCE}\n// more\n// changes\n// to\n// the\n// file\n` });
    assert.deepEqual(outcomes(await run(repo, {})), [['skipped', 'src/queue.ts already has a queued Workout from a commit']]);
  });

  it('expires stale commit Workouts, freeing the queue', async () => {
    const { repo } = await repoWithChange();
    await run(repo, {});
    const paths = workspacePaths(repo);
    const later = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
    assert.equal((await expireStaleWorkouts(paths, 14, later)).length, 1);
    assert.deepEqual((await listWorkouts(paths)).map((w) => w.status), ['discarded']);
    assert.equal((await readState(paths)).discarded[(await listWorkouts(paths))[0]!.record.id]!.reason, 'expired');
  });

  it('serves Drills from AI-authored commits first', async () => {
    const { repo } = await repoWithChange('Co-Authored-By: Cursor <cursoragent@cursor.com>');
    await run(repo, {});
    await commit(repo, { 'src/manual.ts': TS_REFERENCE });
    await run(repo, {}, [goodDrill({ slug: 'human-written' })]);
    const next = await nextQuickWorkout(workspacePaths(repo));
    assert.equal(next?.record.commit?.aiAuthored, true);
  });

  it('reports background failures once', async () => {
    const { repo } = await repoWithChange();
    await configure(repo, backgroundReady);
    await run(repo, { background: true }, [goodDrill({ startingCode: TS_REFERENCE })]);
    const paths = workspacePaths(repo);
    assert.equal(await unseenFailureSummary(paths), '1 background Drill failed: see `fiu log`.');
    assert.equal(await unseenFailureSummary(paths), undefined);
    assert.match(await readFile(join(paths.root, 'log'), 'utf8'), /"outcome":"failed"/);
  });
});

describe(`Predictions from commits (${sandboxWorks ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  /** A commit that made ties first come, first served (the newest job used to win), with notes long enough to count. */
  async function repoWithBehaviourChange(kinds: string[]): Promise<{ repo: string; sha: string }> {
    const repo = await tempGitRepo();
    await git(repo, 'config', 'user.email', ME);
    const notes = (rule: string) => [1, 2, 3, 4].map((n) => `// Rule ${n}: ${rule}.`).join('\n') + '\n';
    await commit(repo, { 'src/queue.ts': `${TS_BEFORE_COMMIT}${notes('the newest job wins a tie')}` });
    const sha = await commit(repo, { 'src/queue.ts': `${TS_REFERENCE}${notes('ties go to the first job')}` }, { message: 'Serve ties first come, first served' });
    await configure(repo, { kinds });
    return { repo, sha };
  }

  it('asks what the code does now, with the code before the commit as a measured wrong option', async () => {
    const { repo, sha } = await repoWithBehaviourChange(['prediction', 'drill']);
    const result = await run(repo, {}, [goodCommitPrediction()]);
    assert.deepEqual(outcomes(result).map(([o]) => o), ['generated'], JSON.stringify(result.outcomes));
    assert.match(result.prompts[0]!, /This is a Prediction from a commit/);
    assert.match(result.prompts[0]!, /<source-before-commit>[\s\S]*job\.at > best\.at[\s\S]*<\/source-before-commit>/);

    const [workout] = await listWorkouts(workspacePaths(repo));
    assert.equal(workout!.record.kind, 'prediction');
    assert.deepEqual(workout!.record.commit, { sha, aiAuthored: false, subject: 'Serve ties first come, first served' });
    assert.equal(workout!.record.files.previous, '.solution/previous.ts');
    assert.equal(await readFile(join(workout!.dir, '.solution', 'previous.ts'), 'utf8'), TS_BEFORE_COMMIT);
  });

  it('never makes a Diagnosis from a commit, whatever kinds says', async () => {
    const skipped = await repoWithBehaviourChange(['diagnosis', 'drill']);
    await run(skipped.repo, {}, [goodDrill()]);
    assert.equal((await listWorkouts(workspacePaths(skipped.repo)))[0]!.record.kind, 'drill');
    const only = await repoWithBehaviourChange(['diagnosis']);
    await run(only.repo, {}, [goodCommitPrediction()]);
    assert.equal((await listWorkouts(workspacePaths(only.repo)))[0]!.record.kind, 'prediction');
  });

  it('falls back to the next kind when the commit changed no behaviour', async () => {
    const { repo } = await repoWithBehaviourChange(['prediction', 'drill']);
    const result = await run(repo, {}, [{ ...goodCommitPrediction(), worthPracticing: false, notWorthReason: 'Only comments changed.' }, goodDrill()]);
    assert.deepEqual(outcomes(result).map(([o]) => o), ['generated']);
    assert.equal(result.prompts.length, 2);
    assert.equal((await listWorkouts(workspacePaths(repo)))[0]!.record.kind, 'drill');
    assert.equal((await readState(workspacePaths(repo))).spend.length, 2, 'both generations are paid for');
  });

  it('with no kind to fall back to, skips the commit for good', async () => {
    const { repo, sha } = await repoWithBehaviourChange(['prediction']);
    const result = await run(repo, {}, [{ ...goodCommitPrediction(), worthPracticing: false, notWorthReason: 'Only comments changed.' }]);
    assert.deepEqual(outcomes(result), [['not-worth-practicing', 'Only comments changed.']]);
    assert.ok((await readState(workspacePaths(repo))).refill.processed.includes(sha));
  });

  it('makes no Prediction from a file the commit added', async () => {
    const repo = await tempGitRepo();
    await git(repo, 'config', 'user.email', ME);
    await commit(repo, { 'README.md': 'x\n' });
    await commit(repo, { 'src/queue.ts': TS_REFERENCE });
    await configure(repo, { kinds: ['prediction', 'drill'] });
    const result = await run(repo, {}, [goodDrill()]);
    assert.equal(result.prompts.length, 1, 'no model call for the Prediction');
    assert.doesNotMatch(result.prompts[0]!, /source-before-commit/);
    assert.equal((await listWorkouts(workspacePaths(repo)))[0]!.record.kind, 'drill');
    const only = await run(repo, { kinds: ['prediction'], commit: 'HEAD' }, []);
    assert.deepEqual(outcomes(only), [['skipped', 'already processed']]);
  });
});
