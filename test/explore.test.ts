import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { countsTowardQueueCap } from '../src/background/refill.ts';
import { costReport } from '../src/commands/cost.ts';
import { explore, type ExploreOptions } from '../src/commands/explore.ts';
import { continueTrack, formatProgress } from '../src/commands/track.ts';
import type { TrainIo } from '../src/commands/train.ts';
import { checkPlan, type TrackPlan } from '../src/explore/plan.ts';
import { ExploreTargetError, shortlist } from '../src/explore/shortlist.ts';
import { listTracks, loadTrack, trackProgress } from '../src/explore/tracks.ts';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { profiles } from '../src/languages/registry.ts';
import { openSandbox, SandboxUnavailableError } from '../src/sandbox/sandbox.ts';
import type { DrillOutput } from '../src/synthesis/schema.ts';
import { openAttempt, saveAttempt } from '../src/workouts/attempts.ts';
import { nextQuickWorkout } from '../src/workouts/queue.ts';
import type { WorkoutRecord } from '../src/workouts/save.ts';
import { listWorkouts, loadWorkout, readState } from '../src/workouts/store.ts';
import { workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';
import { goodDrill, scriptedModel, TS_REFERENCE } from './mock-model.ts';

const sandboxWorks = await openSandbox().then(
  async (s) => (await s.dispose(), true),
  (error) => {
    if (error instanceof SandboxUnavailableError) return false;
    throw error;
  },
);

/** A source file long enough to be a candidate, with some branching. */
const source = (name: string, branches = 4) =>
  `${TS_REFERENCE}\n${Array.from({ length: branches }, (_, i) => `export const ${name}${i} = (x: number) => (x > ${i} ? x : ${i});`).join('\n')}\n${Array.from({ length: 8 }, (_, i) => `// ${name} note ${i}`).join('\n')}\n`;

async function repoWithModule(files: Record<string, string>): Promise<string> {
  const repo = await tempGitRepo();
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(repo, name, '..'), { recursive: true });
    await writeFile(join(repo, name), content);
  }
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'module'], { cwd: repo });
  return repo;
}

const MODULE = {
  'src/core/store.ts': source('store', 9),
  'src/core/queue.ts': source('queue', 7),
  'src/core/worker.ts': source('worker', 5),
  'src/core/extra.ts': source('extra', 3),
  'src/core/store.test.ts': source('t', 20),
  'src/core/tiny.ts': 'export const tiny = 1;\n',
};

const plan = (steps: string[], alternates: string[] = []): TrackPlan => ({
  title: 'The job scheduler',
  steps: steps.map((path) => ({ path, pillar: 'algorithm', why: `${path} is what the rest builds on.` })),
  alternates: alternates.map((path) => ({ path, pillar: 'pattern', why: `${path} wires things together.` })),
});

async function run(repo: string, replies: (TrackPlan | Partial<DrillOutput> | string)[], options: Partial<ExploreOptions> = {}, confirm?: (m: string) => Promise<boolean>) {
  const scripted = scriptedModel(...(replies as never[]));
  const steps: string[] = [];
  const result = await explore(
    repo,
    'src/core',
    { yes: true, sandbox: sandboxWorks, ...options },
    { step: (m) => steps.push(m), warn: () => {}, confirm },
    {
      createModel: () => ({ model: scripted.model, providerOptions: {} }),
      configEnv: { env: { ANTHROPIC_API_KEY: 'k' }, home: await tempDir() },
      cacheRoot: await tempDir(),
    },
  );
  return { result, prompts: scripted.prompts, steps };
}

const bad = goodDrill({ startingCode: TS_REFERENCE });

describe('the shortlist', () => {
  it('keeps logic-dense source files, densest first, and leaves out tests and tiny files', async () => {
    const repo = await repoWithModule(MODULE);
    const candidates = await shortlist(repo, 'src/core', profiles());
    assert.deepEqual(
      candidates.map((c) => c.path),
      ['src/core/store.ts', 'src/core/queue.ts', 'src/core/worker.ts', 'src/core/extra.ts'],
    );
    assert.ok(candidates[0]!.outline.some((line) => line.startsWith('export function pickNext')));
  });

  it('needs a directory inside the repository', async () => {
    const repo = await repoWithModule(MODULE);
    await assert.rejects(shortlist(repo, 'src/core/store.ts', profiles()), /is a file: explore a module directory/);
    await assert.rejects(shortlist(repo, 'nope', profiles()), ExploreTargetError);
  });
});

describe('checkPlan', () => {
  it('accepts 3 to 5 distinct candidate files and rejects anything else', async () => {
    const repo = await repoWithModule(MODULE);
    const candidates = await shortlist(repo, 'src/core', profiles());
    assert.deepEqual(checkPlan(plan(['src/core/store.ts', 'src/core/queue.ts', 'src/core/worker.ts']), candidates), []);
    const problems = checkPlan(plan(['src/core/store.ts', 'src/core/store.ts', 'src/core/nope.ts', 'src/core/tiny.ts', 'a', 'b']), candidates);
    assert.ok(problems.some((p) => /choose 3 to 5 steps, not 6/.test(p)));
    assert.ok(problems.some((p) => /store\.ts appears more than once/.test(p)));
    assert.ok(problems.some((p) => /nope\.ts is not one of the candidate files/.test(p)));
  });
});

describe(`kin explore (${sandboxWorks ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  const three = ['src/core/store.ts', 'src/core/queue.ts', 'src/core/worker.ts'];

  it('builds a Track: steps in the planned order, each a Drill with its why', async () => {
    const repo = await repoWithModule(MODULE);
    const { result, prompts } = await run(repo, [plan(three, ['src/core/extra.ts']), goodDrill({ slug: 's1' }), goodDrill({ slug: 's2' }), goodDrill({ slug: 's3' })]);
    assert.equal(result.status, 'saved', JSON.stringify(result));
    const track = result.status === 'saved' ? result.track : assert.fail();
    assert.deepEqual(track.steps.map((s) => s.path), three);
    assert.equal(track.module, 'src/core');
    assert.match(track.id, /^track_\d{8}_src-core$/);

    assert.match(prompts[0]!, /Candidate files, with their declarations/);
    assert.match(prompts[1]!, /step 1 of 3 in a Track teaching a newcomer the module src\/core\. This file matters because: src\/core\/store\.ts is what the rest builds on\./);

    const paths = workspacePaths(repo);
    const first = await loadWorkout(paths, track.steps[0]!.workoutId);
    assert.equal(first.record.origin, 'explore');
    assert.deepEqual((first.record as WorkoutRecord).track, { id: track.id, title: 'The job scheduler', module: 'src/core', why: 'src/core/store.ts is what the rest builds on.' });
    assert.match(await readFile(join(first.dir, 'README.md'), 'utf8'), /^\*Part of the Track "The job scheduler": src\/core\/store\.ts is what the rest builds on\.\*$/m);

    const ledger = (await readState(paths)).spend.map((e) => e.result);
    assert.deepEqual(ledger, ['track-plan', 'verified', 'verified', 'verified']);
    assert.equal((await costReport(repo)).trackPlanning.count, 1);
    assert.deepEqual((await listTracks(paths)).map((t) => t.id), [track.id]);
  });

  it('replaces a step that cannot be Verified with the next alternate, in the same place', async () => {
    const repo = await repoWithModule(MODULE);
    const { result } = await run(repo, [plan(three, ['src/core/extra.ts']), goodDrill({ slug: 's1' }), bad, bad, bad, goodDrill({ slug: 'alt' }), goodDrill({ slug: 's3' })]);
    assert.equal(result.status, 'saved');
    assert.deepEqual(result.status === 'saved' && result.track.steps.map((s) => s.path), ['src/core/store.ts', 'src/core/extra.ts', 'src/core/worker.ts']);
    assert.deepEqual(result.status === 'saved' && result.dropped, ['src/core/queue.ts: no Verified Drill']);
  });

  it('saves no Track with fewer than 3 Verified steps, keeping the Drills that worked', async () => {
    const repo = await repoWithModule(MODULE);
    const { result } = await run(repo, [plan(three), goodDrill({ slug: 's1' }), bad, bad, bad, goodDrill({ slug: 's3' })]);
    assert.equal(result.status, 'not-enough');
    assert.equal(result.status === 'not-enough' && result.workoutIds.length, 2);
    const paths = workspacePaths(repo);
    assert.deepEqual(await listTracks(paths), []);
    assert.equal((await listWorkouts(paths)).length, 2);
  });

  it('shows the plan and an estimate before generating, and stops there if declined', async () => {
    const repo = await repoWithModule(MODULE);
    const asked: string[] = [];
    const confirm = async (message: string) => (asked.push(message), !message.startsWith('Track'));
    const { result, prompts } = await run(repo, [plan(three)], { yes: false }, confirm);
    assert.equal(result.status, 'declined');
    assert.equal(prompts.length, 1, 'only the planning call');
    const question = asked.find((m) => m.startsWith('Track'))!;
    assert.match(question, /1\. src\/core\/store\.ts: src\/core\/store\.ts is what the rest builds on\./);
    assert.match(question, /Generate these 3 Drills now\? Estimated cost unknown \(no cost history yet\)\./);
  });

  it('retries a plan that names files outside the shortlist', async () => {
    const repo = await repoWithModule(MODULE);
    const { result, prompts } = await run(repo, [plan(['src/core/tiny.ts', ...three.slice(1)]), plan(three), goodDrill({ slug: 'a' }), goodDrill({ slug: 'b' }), goodDrill({ slug: 'c' })]);
    assert.equal(result.status, 'saved');
    assert.match(prompts[1]!, /tiny\.ts is not one of the candidate files/);
  });

  it('keeps Track Drills out of kin quick and the background queue cap', async () => {
    const repo = await repoWithModule(MODULE);
    await run(repo, [plan(three), goodDrill({ slug: 'a', estimatedMinutes: 4 }), goodDrill({ slug: 'b', estimatedMinutes: 4 }), goodDrill({ slug: 'c', estimatedMinutes: 4 })]);
    const paths = workspacePaths(repo);
    assert.equal(await nextQuickWorkout(paths), undefined);
    assert.equal(countsTowardQueueCap(await listWorkouts(paths)), 0);
  });

  it('kin track opens the next step and reports a finished Track', async () => {
    const repo = await repoWithModule(MODULE);
    const { result } = await run(repo, [plan(three), goodDrill({ slug: 'a' }), goodDrill({ slug: 'b' }), goodDrill({ slug: 'c' })]);
    const track = result.status === 'saved' ? result.track : assert.fail();
    const paths = workspacePaths(repo);

    // Step 1 already done.
    const { attempt } = await openAttempt(paths, await loadWorkout(paths, track.steps[0]!.workoutId), TYPESCRIPT);
    attempt.record.outcome = 'completed';
    await saveAttempt(attempt);

    const printed: string[] = [];
    const io: TrainIo = {
      print: (text) => printed.push(text),
      readKey: () => new Promise((resolve) => setTimeout(() => resolve('q'), 50)),
      pick: async () => undefined,
      rate: async () => undefined,
    };
    const opened = await continueTrack(repo, track.id, { sandbox: sandboxWorks }, io, { configEnv: { env: {}, home: await tempDir() }, cacheRoot: await tempDir() });
    assert.deepEqual(opened, { status: 'left-pending', workoutId: track.steps[1]!.workoutId, attempt: 1 });
    assert.match(printed[0]!, /1 of 3 done\n {2}✓ 1\. src\/core\/store\.ts\n[\s\S]*○ 2\. src\/core\/queue\.ts {2}← next/);

    for (const step of track.steps.slice(1)) {
      const { attempt: a } = await openAttempt(paths, await loadWorkout(paths, step.workoutId), TYPESCRIPT);
      a.record.outcome = 'abandoned';
      await saveAttempt(a);
    }
    const finished = await continueTrack(repo, track.id, { sandbox: sandboxWorks }, io);
    assert.equal(finished.status, 'track-complete');
    const { steps } = await trackProgress(paths, await loadTrack(paths, track.id));
    assert.match(formatProgress(track, steps), /3 of 3 done/);
  });
});
