import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { countsTowardQueueCap } from '../src/background/refill.ts';
import { costReport } from '../src/commands/cost.ts';
import { explore, moduleAbout, type ExploreOptions } from '../src/commands/explore.ts';
import { continueTrack, formatProgress } from '../src/commands/track.ts';
import type { TrainIo } from '../src/commands/train.ts';
import { emptyAtlas } from '../src/atlas/store.ts';
import { candidatesPrompt, checkPlan, trackKinds, trackRules, withAtlas, type TrackPlan } from '../src/explore/plan.ts';
import { ExploreTargetError, shortlist } from '../src/explore/shortlist.ts';
import { listTracks, loadTrack, trackProgress } from '../src/explore/tracks.ts';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { profiles } from '../src/languages/registry.ts';
import { openSandbox, SandboxUnavailableError } from '../src/sandbox/sandbox.ts';
import type { DrillOutput, WorkoutKind } from '../src/synthesis/schema.ts';
import { openAttempt, saveAttempt } from '../src/workouts/attempts.ts';
import { nextQuickWorkout } from '../src/workouts/queue.ts';
import type { WorkoutRecord } from '../src/workouts/save.ts';
import { averageSpend, listWorkouts, loadWorkout, readState } from '../src/workouts/store.ts';
import { workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';
import { goodDiagnosis, goodDrill, goodKata, goodPrediction, scriptedModel, TS_REFERENCE } from './mock-model.ts';

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

const plan = (steps: string[], alternates: string[] = [], kinds: WorkoutKind[] = []): TrackPlan => ({
  title: 'The job scheduler',
  steps: steps.map((path, i) => ({ path, kind: kinds[i] ?? 'drill', pillar: 'algorithm', why: `${path} is what the rest builds on.` })),
  alternates: alternates.map((path) => ({ path, kind: 'drill', pillar: 'pattern', why: `${path} wires things together.` })),
});

async function run(repo: string, replies: (TrackPlan | Partial<DrillOutput> | string)[], options: Partial<ExploreOptions> = {}, confirm?: (m: string) => Promise<boolean>) {
  const scripted = scriptedModel(...(replies as never[]));
  const steps: string[] = [];
  const result = await explore(
    repo,
    'src/core',
    // Drill-only unless a test asks for a mix: the scripted replies are Drills.
    { yes: true, sandbox: sandboxWorks, kinds: ['drill'], ...options },
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

describe('Tracks and the Atlas', () => {
  it('shows what the Atlas says a candidate is for in place of its declarations', async () => {
    const repo = await repoWithModule(MODULE);
    const atlas = emptyAtlas();
    atlas.files['src/core/store.ts'] = { hash: 'h', text: 'Keeps the jobs.', writtenAt: '2026-10-30T00:00:00.000Z', functions: { pickNext: 'Chooses the next job.' } };
    const candidates = withAtlas(await shortlist(repo, 'src/core', profiles()), atlas);
    const prompt = candidatesPrompt('src/core', candidates);
    assert.match(prompt, /with what each is for \(from the Atlas\) or its declarations:/);
    assert.match(prompt, /- src\/core\/store\.ts \(\d+ lines\)\n {4}Keeps the jobs\.\n {4}pickNext: Chooses the next job\.\n- src\/core\/queue\.ts \(\d+ lines\)\n {4}export interface Job/);
  });

  it('chooses the module a goal is about, walking up to a folder with enough files', async () => {
    const repo = await repoWithModule({ ...MODULE, 'src/core/deep/lonely.ts': source('lonely'), 'src/web/page.ts': source('page') });
    const configEnv = { env: {}, home: await tempDir() };
    assert.equal(await moduleAbout(repo, 'how the worker queue works', configEnv), 'src/core');
    assert.equal(await moduleAbout(repo, 'lonely', configEnv), 'src/core');
    await assert.rejects(moduleAbout(repo, 'payments', configEnv), /Nothing matches "payments" well enough to choose a module\. Only names are searched/);
  });
});

describe('checkPlan', () => {
  it('accepts 3 to 5 distinct candidate files and rejects anything else', async () => {
    const repo = await repoWithModule(MODULE);
    const candidates = await shortlist(repo, 'src/core', profiles());
    assert.deepEqual(checkPlan(plan(['src/core/store.ts', 'src/core/queue.ts', 'src/core/worker.ts']), candidates, ['drill']), []);
    const problems = checkPlan(plan(['src/core/store.ts', 'src/core/store.ts', 'src/core/nope.ts', 'src/core/tiny.ts', 'a', 'b']), candidates);
    assert.ok(problems.some((p) => /choose 3 to 5 steps, not 6/.test(p)));
    assert.ok(problems.some((p) => /store\.ts appears more than once/.test(p)));
    assert.ok(problems.some((p) => /nope\.ts is not one of the candidate files/.test(p)));
  });

  it('holds steps to the allowed kinds, and a Track to at least two of them', async () => {
    const repo = await repoWithModule(MODULE);
    const candidates = await shortlist(repo, 'src/core', profiles());
    const files = ['src/core/store.ts', 'src/core/queue.ts', 'src/core/worker.ts'];
    assert.deepEqual(checkPlan(plan(files, [], ['prediction', 'drill', 'kata']), candidates), []);
    assert.deepEqual(checkPlan(plan(files), candidates), ['every step is a drill: use at least two kinds of prediction, diagnosis, drill, kata.']);
    assert.deepEqual(checkPlan(plan(files, [], ['prediction', 'kata', 'kata']), candidates, ['prediction']), [
      "src/core/queue.ts is a kata, which this Track doesn't allow: use prediction.",
      "src/core/worker.ts is a kata, which this Track doesn't allow: use prediction.",
    ]);
  });
});

describe('averageSpend by kind', () => {
  it('prices a kind from the Workouts of that kind only', () => {
    const entry = (workoutId: string, usd: number) => ({ at: '2026-10-31T00:00:00.000Z', origin: 'manual' as const, generator: 'fiu' as const, source: 'a.ts', result: 'verified' as const, workoutId, generationAttempts: 1, cost: { usage: [], usd, unpricedModels: [], pricesAsOf: '2026-10' } });
    const spend = [entry('drill_1', 0.4), entry('prediction_1', 0.2), entry('kata_1', 0.6)];
    assert.equal(averageSpend(spend, 10, 'prediction')?.usd, 0.2);
    assert.equal(averageSpend(spend, 10, 'kata')?.usd, 0.6);
    assert.equal(averageSpend(spend)?.usd.toFixed(2), '0.40');
  });
});

describe('trackKinds', () => {
  it('mixes all four by default, only no-code kinds for someone who reads no code, or what --kinds says', () => {
    assert.deepEqual(trackKinds(['drill']), ['prediction', 'diagnosis', 'drill', 'kata']);
    assert.deepEqual(trackKinds(['prediction', 'drill']), ['prediction', 'diagnosis', 'drill', 'kata']);
    assert.deepEqual(trackKinds(['prediction']), ['prediction']);
    assert.deepEqual(trackKinds(['diagnosis', 'prediction']), ['prediction', 'diagnosis']);
    assert.deepEqual(trackKinds(['prediction'], ['kata', 'drill']), ['drill', 'kata']);
  });

  it('gives the planner rules for the allowed kinds only', () => {
    assert.match(trackRules(), /Use at least two different kinds across the steps/);
    assert.match(trackRules(['prediction']), /Every step is a Prediction\./);
    assert.doesNotMatch(trackRules(['drill', 'kata']), /^- prediction:/m);
  });
});

describe(`fiu explore (${sandboxWorks ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
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
    assert.match(question, /1\. Drill · algorithm: src\/core\/store\.ts: src\/core\/store\.ts is what the rest builds on\./);
    assert.match(question, /Generate these 3 Workouts now\? Estimated cost unknown \(no cost history yet\)\./);
  });

  it('mixes kinds: each step generated as the kind the plan chose', async () => {
    const repo = await repoWithModule(MODULE);
    const mixed = plan(three, [], ['prediction', 'drill', 'kata']);
    const { result, prompts } = await run(repo, [mixed, goodPrediction(), goodDrill({ slug: 'b' }), goodKata()], { kinds: undefined });
    assert.equal(result.status, 'saved', JSON.stringify(result));
    if (result.status !== 'saved') return;
    assert.deepEqual(result.track.steps.map((s) => s.kind), ['prediction', 'drill', 'kata']);
    assert.match(prompts[0]!, /The allowed kinds:\\n- prediction:/);
    assert.match(prompts[1]!, /This Prediction is step 1 of 3 in a Track/);
    assert.doesNotMatch(prompts[1]!, /This is a Series/);
    const readme = await readFile(join(workspacePaths(repo).workoutsDir, result.track.steps[0]!.workoutId, 'README.md'), 'utf8');
    assert.match(readme, /\*Part of the Track "The job scheduler": src\/core\/store\.ts is what the rest builds on\.\*/);
  });

  it('makes a Diagnosis as a Track step', async () => {
    const repo = await repoWithModule(MODULE);
    const { result } = await run(repo, [plan(three, [], ['prediction', 'diagnosis', 'kata']), goodPrediction(), goodDiagnosis(), goodKata()], { kinds: undefined });
    assert.equal(result.status, 'saved', JSON.stringify(result));
    if (result.status !== 'saved') return;
    assert.deepEqual(result.track.steps.map((s) => s.kind), ['prediction', 'diagnosis', 'kata']);
    const readme = await readFile(join(workspacePaths(repo).workoutsDir, result.track.steps[1]!.workoutId, 'README.md'), 'utf8');
    assert.match(readme, /\*Part of the Track "The job scheduler": [^]*Practice incident/);
  });

  it('falls back to a Drill on the same file when a step of another kind fails and no alternate is left', async () => {
    const repo = await repoWithModule(MODULE);
    const mixed = plan(three, [], ['prediction', 'drill', 'kata']);
    const { result } = await run(repo, [mixed, 'not json', 'not json', 'not json', goodDrill({ slug: 'a' }), goodDrill({ slug: 'b' }), goodKata()], { kinds: undefined });
    assert.equal(result.status, 'saved', JSON.stringify(result));
    if (result.status !== 'saved') return;
    assert.deepEqual(result.track.steps.map((s) => [s.path, s.kind]), [['src/core/store.ts', 'drill'], ['src/core/queue.ts', 'drill'], ['src/core/worker.ts', 'kata']]);
    assert.deepEqual(result.dropped, ['src/core/store.ts: no Verified Prediction']);
  });

  it('retries a plan that names files outside the shortlist', async () => {
    const repo = await repoWithModule(MODULE);
    const { result, prompts } = await run(repo, [plan(['src/core/tiny.ts', ...three.slice(1)]), plan(three), goodDrill({ slug: 'a' }), goodDrill({ slug: 'b' }), goodDrill({ slug: 'c' })]);
    assert.equal(result.status, 'saved');
    assert.match(prompts[1]!, /tiny\.ts is not one of the candidate files/);
  });

  it('keeps Track Drills out of fiu quick and the background queue cap', async () => {
    const repo = await repoWithModule(MODULE);
    await run(repo, [plan(three), goodDrill({ slug: 'a', estimatedMinutes: 4 }), goodDrill({ slug: 'b', estimatedMinutes: 4 }), goodDrill({ slug: 'c', estimatedMinutes: 4 })]);
    const paths = workspacePaths(repo);
    assert.equal(await nextQuickWorkout(paths), undefined);
    assert.equal(countsTowardQueueCap(await listWorkouts(paths)), 0);
  });

  it('fiu track opens the next step and reports a finished Track', async () => {
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
      confirmDefect: async () => undefined,
    };
    const opened = await continueTrack(repo, track.id, { sandbox: sandboxWorks }, io, { configEnv: { env: {}, home: await tempDir() }, cacheRoot: await tempDir() });
    assert.deepEqual(opened, { status: 'left-pending', workoutId: track.steps[1]!.workoutId, attempt: 1 });
    assert.match(printed[0]!, /1 of 3 done\n {2}✓ 1\. Drill · algorithm: src\/core\/store\.ts\n[\s\S]*○ 2\. Drill · algorithm: src\/core\/queue\.ts {2}← next/);

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
