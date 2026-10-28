import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { expireStaleWorkouts } from '../src/background/refill.ts';
import { listTracks, saveTrack } from '../src/explore/tracks.ts';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { openSandbox, SandboxUnavailableError } from '../src/sandbox/sandbox.ts';
import { SHARED_REF } from '../src/sharing/git.ts';
import { fetchWorkouts, fingerprint, NotShareableError, share } from '../src/sharing/share.ts';
import type { DrillOutput } from '../src/synthesis/schema.ts';
import { saveDrill, sourceRevision, type WorkoutRecord } from '../src/workouts/save.ts';
import { listWorkouts } from '../src/workouts/store.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, workspacePaths } from '../src/workspace.ts';
import { tempDir } from './helpers.ts';
import { goodDrill, goodKata, TS_REFERENCE } from './mock-model.ts';

const sandboxWorks = await openSandbox().then(
  async (s) => (await s.dispose(), true),
  (error) => {
    if (error instanceof SandboxUnavailableError) return false;
    throw error;
  },
);

const git = async (cwd: string, ...args: string[]) => (await execa('git', args, { cwd })).stdout;

/** A bare "origin" and two teammates' clones of it, sharing one committed and pushed source file. */
async function team() {
  const origin = await tempDir();
  await git(origin, 'init', '-q', '--bare');
  const clone = async (name: string) => {
    const dir = join(await tempDir(), name);
    await execa('git', ['clone', '-q', origin, dir]);
    await git(dir, 'config', 'user.name', name);
    await git(dir, 'config', 'user.email', `${name}@team.dev`);
    await ensureWorkspace(workspacePaths(dir));
    await excludeWorkspaceFromGit(dir);
    return dir;
  };
  const alice = await clone('alice');
  await writeFile(join(alice, 'queue.ts'), TS_REFERENCE);
  await git(alice, 'add', 'queue.ts');
  await git(alice, 'commit', '-qm', 'queue');
  await git(alice, 'push', '-q', 'origin', 'HEAD');
  const bob = await clone('bob');
  return { origin, alice, bob };
}

async function drillIn(repo: string, overrides: Partial<DrillOutput> = {}, dirty = false) {
  return saveDrill({
    paths: workspacePaths(repo),
    profile: TYPESCRIPT,
    drill: goodDrill(overrides),
    sourcePath: 'queue.ts',
    revision: dirty ? { dirty: true } : await sourceRevision(repo, 'queue.ts'),
    generationAttempts: 1,
  });
}

const fetchFor = async (repo: string) => fetchWorkouts(repo, { sandbox: sandboxWorks }, () => {}, { configEnv: { env: {}, home: await tempDir() }, cacheRoot: await tempDir() });

describe(`team sharing (${sandboxWorks ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  it('shares a Workout on the kintsugi/workouts branch without touching the checkout, and a teammate fetches it', async () => {
    const { origin, alice, bob } = await team();
    const workout = await drillIn(alice);
    const branchBefore = await git(alice, 'rev-parse', '--abbrev-ref', 'HEAD');

    const report = await share(alice, [workout.id]);
    assert.deepEqual(report.shared, [{ id: workout.id, as: workout.id, kind: 'workout' }]);
    assert.deepEqual(report.warnings, []);
    assert.equal(await git(alice, 'rev-parse', '--abbrev-ref', 'HEAD'), branchBefore);
    assert.equal(await git(alice, 'status', '--porcelain'), '');
    assert.equal(await git(alice, 'branch', '--list', 'kintsugi/*'), '', 'no local branch appears');
    const files = await git(origin, 'ls-tree', '-r', '--name-only', 'kintsugi/workouts');
    assert.match(files, new RegExp(`^workouts/${workout.id}/\\.solution/kata\\.ts$`, 'm'));
    assert.doesNotMatch(files, /attempts|state\.json|config\.json/);

    const fetched = await fetchFor(bob);
    assert.deepEqual(fetched.imported, [{ id: workout.id, as: workout.id }]);
    const [mine] = await listWorkouts(workspacePaths(bob));
    assert.equal(mine!.status, 'queued');
    for (const file of ['kata.ts', 'kata.test.ts', 'README.md', '.solution/kata.ts']) {
      const original = await readFile(join(workspacePaths(alice).workoutsDir, workout.id, file));
      assert.ok(original.equals(await readFile(join(mine!.dir, file))), `${file} arrives byte for byte`);
    }
    assert.deepEqual({ ...mine!.record.sharedBy, at: undefined }, { name: 'alice', email: 'alice@team.dev', at: undefined });

    assert.deepEqual((await fetchFor(bob)).alreadyHave, [workout.id], 'fetching again is a no-op');
    assert.deepEqual((await share(alice, [workout.id])).alreadyShared, [workout.id], 'sharing again is a no-op');
  });

  it('re-verifies a shared Kata as a Kata', async () => {
    const { alice, bob } = await team();
    const kata = await saveDrill({
      paths: workspacePaths(alice),
      profile: TYPESCRIPT,
      drill: goodKata(),
      kind: 'kata',
      sourcePath: 'queue.ts',
      revision: await sourceRevision(alice, 'queue.ts'),
      generationAttempts: 1,
    });
    await share(alice, [kata.id]);
    const fetched = await fetchFor(bob);
    assert.deepEqual(fetched.imported, [{ id: kata.id, as: kata.id }], JSON.stringify(fetched));
    assert.equal((await listWorkouts(workspacePaths(bob)))[0]!.record.kind, 'kata');
  });

  it('combines both sets when a teammate pushed first', async () => {
    const { origin, alice, bob } = await team();
    const fromAlice = await drillIn(alice, { slug: 'from-alice' });
    await git(bob, 'pull', '-q');
    const fromBob = await drillIn(bob, { slug: 'from-bob' });
    await share(alice, [fromAlice.id]);
    // Bob never fetched Alice's push: his share must fetch, combine, and push again.
    await share(bob, [fromBob.id]);
    const files = await git(origin, 'ls-tree', '-r', '--name-only', 'kintsugi/workouts');
    assert.match(files, new RegExp(`workouts/${fromAlice.id}/workout\\.json`));
    assert.match(files, new RegExp(`workouts/${fromBob.id}/workout\\.json`));
  });

  it('refuses Workouts from uncommitted code and warns about unpushed commits', async () => {
    const { alice } = await team();
    const dirty = await drillIn(alice, { slug: 'dirty' }, true);
    await assert.rejects(share(alice, [dirty.id]), NotShareableError);

    await writeFile(join(alice, 'queue.ts'), `${TS_REFERENCE}\n// local only\n`);
    await git(alice, 'commit', '-qam', 'not pushed');
    const unpushed = await drillIn(alice, { slug: 'unpushed' });
    const report = await share(alice, [unpushed.id]);
    assert.match(report.warnings[0]!, /isn't on a remote branch yet: push your branch/);
    assert.equal(report.shared.length, 1);
  });

  it('imports a different Workout with a clashing id under a new id', async () => {
    const { alice, bob } = await team();
    const theirs = await drillIn(alice, { slug: 'same-slug', title: "Alice's version" });
    await share(alice, [theirs.id]);
    await git(bob, 'pull', '-q');
    const mine = await drillIn(bob, { slug: 'same-slug', title: "Bob's version" });
    assert.equal(mine.id, theirs.id);

    const fetched = await fetchFor(bob);
    assert.equal(fetched.imported.length, 1);
    const renamed = fetched.imported[0]!.as;
    assert.match(renamed, new RegExp(`^${theirs.id}-[0-9a-f]{6}$`));
    const record: WorkoutRecord = JSON.parse(await readFile(join(workspacePaths(bob).workoutsDir, renamed, 'workout.json'), 'utf8'));
    assert.deepEqual([record.id, record.title], [renamed, "Alice's version"]);
    assert.deepEqual((await fetchFor(bob)).alreadyHave, [theirs.id], 'the renamed import is recognised next time');
  });

  it('rejects a shared Workout that no longer Verifies', async () => {
    const { alice, bob } = await team();
    const workout = await drillIn(alice);
    await share(alice, [workout.id]);
    // Tamper with the shared Reference Solution so the tests fail against it.
    await git(alice, 'fetch', '-q', 'origin', `+refs/heads/kintsugi/workouts:${SHARED_REF}`);
    const tampered = (await git(alice, 'show', `${SHARED_REF}:workouts/${workout.id}/.solution/kata.ts`)).replace('job.at < best.at', 'job.at > best.at');
    const blob = (await execa('git', ['hash-object', '-w', '--stdin'], { cwd: alice, input: tampered })).stdout;
    const index = join(await tempDir(), 'index');
    const env = { GIT_INDEX_FILE: index };
    await execa('git', ['read-tree', SHARED_REF], { cwd: alice, env });
    await execa('git', ['update-index', '--cacheinfo', `100644,${blob},workouts/${workout.id}/.solution/kata.ts`], { cwd: alice, env });
    const tree = (await execa('git', ['write-tree'], { cwd: alice, env })).stdout;
    const commit = await git(alice, 'commit-tree', tree, '-p', SHARED_REF, '-m', 'tamper');
    await git(alice, 'push', '-q', 'origin', `${commit}:refs/heads/kintsugi/workouts`);

    const fetched = await fetchFor(bob);
    assert.deepEqual(fetched.imported, []);
    assert.equal(fetched.rejected[0]!.id, workout.id);
    assert.match(fetched.rejected[0]!.reason, /reference-passes/);
  });

  it('shares a Track with its steps, and fetched Workouts never expire', async () => {
    const { alice, bob } = await team();
    const steps = [await drillIn(alice, { slug: 's1' }), await drillIn(alice, { slug: 's2' }), await drillIn(alice, { slug: 's3' })];
    await saveTrack(workspacePaths(alice), {
      id: 'track_20261028_core',
      title: 'Core',
      module: '.',
      createdAt: new Date().toISOString(),
      generator: 'agent',
      steps: steps.map((s) => ({ workoutId: s.id, path: 'queue.ts', pillar: 'algorithm', why: 'it matters' })),
    });
    const report = await share(alice, ['track_20261028_core']);
    assert.deepEqual(report.shared.map((s) => s.kind), ['workout', 'workout', 'workout', 'track']);

    const fetched = await fetchFor(bob);
    assert.deepEqual(fetched.tracks, [{ id: 'track_20261028_core', as: 'track_20261028_core' }]);
    const [track] = await listTracks(workspacePaths(bob));
    assert.equal(track!.sharedBy?.name, 'alice');
    assert.deepEqual(track!.steps.map((s) => s.workoutId), steps.map((s) => s.id));

    // A teammate's commit Drill arriving long after it was made must not expire on arrival.
    const paths = workspacePaths(bob);
    const later = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    assert.deepEqual(await expireStaleWorkouts(paths, 14, later), []);
  });

  it('fingerprints content, not ids or sharing stamps', () => {
    const a = new Map([['workout.json', Buffer.from(JSON.stringify({ id: 'x', title: 'T' }))], ['kata.ts', Buffer.from('code')]]);
    const b = new Map([['kata.ts', Buffer.from('code')], ['workout.json', Buffer.from(JSON.stringify({ title: 'T', id: 'y', sharedBy: { name: 'n' } }))]]);
    assert.equal(fingerprint(a), fingerprint(b));
    b.set('kata.ts', Buffer.from('other'));
    assert.notEqual(fingerprint(a), fingerprint(b));
  });
});
