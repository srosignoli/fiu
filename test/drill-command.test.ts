import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { APICallError } from 'ai';
import { costReport, startOfMonth } from '../src/commands/cost.ts';
import { openAttempt } from '../src/workouts/attempts.ts';
import { loadWorkout } from '../src/workouts/store.ts';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { workspacePaths } from '../src/workspace.ts';
import { drill, DrillTargetError, parseTarget, type DrillCommandOptions, type DrillUi } from '../src/commands/drill.ts';
import { ConsentDeclinedError, ConsentRequiredError } from '../src/consent.ts';
import { MissingApiKeyError } from '../src/credentials.ts';
import { openSandbox, SandboxUnavailableError } from '../src/sandbox/sandbox.ts';
import type { WorkoutRecord } from '../src/workouts/save.ts';
import { tempDir, tempGitRepo, writeUaFlows } from './helpers.ts';
import { goodDrill, goodKata, goodPrediction, goodSeries, scriptedModel, tieQuestion, TS_REFERENCE, urgentQuestion } from './mock-model.ts';
import { saveAttempt } from '../src/workouts/attempts.ts';

// Use the real sandbox where it is installed.
const sandboxWorks = await openSandbox().then(
  async (s) => (await s.dispose(), true),
  (error) => {
    if (error instanceof SandboxUnavailableError) return false;
    throw error;
  },
);

async function repoWithSource(): Promise<string> {
  const repo = await tempGitRepo();
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'queue.ts'), TS_REFERENCE);
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

interface Run {
  repo: string;
  options?: Partial<DrillCommandOptions>;
  confirm?: DrillUi['confirm'];
  env?: NodeJS.ProcessEnv;
  replies?: Parameters<typeof scriptedModel>;
  /** null: no target at all, as `fiu predict` with no path. */
  target?: string | null;
}

async function run({ repo, options = {}, confirm, env = { ANTHROPIC_API_KEY: 'test-key' }, replies = [goodDrill()], target = 'src/queue.ts' }: Run) {
  const scripted = scriptedModel(...replies);
  const steps: string[] = [];
  const created: string[] = [];
  const result = await drill(
    repo,
    target ?? undefined,
    { yes: false, sandbox: sandboxWorks, ...options },
    { step: (m) => steps.push(m), warn: (m) => steps.push(`warn: ${m}`), confirm },
    {
      createModel: (provider, modelId, apiKey) => {
        created.push(`${provider}/${modelId}/${apiKey}`);
        return { model: scripted.model, providerOptions: {} };
      },
      configEnv: { env, home: await tempDir() },
      cacheRoot: await tempDir(),
    },
  );
  return { result, steps, created, prompts: scripted.prompts };
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

describe('fiu drill', () => {
  it('generates, verifies, and saves a Drill with its Source Anchors', async () => {
    const repo = await repoWithSource();
    const { result, created } = await run({ repo, options: { yes: true } });

    assert.equal(result.status, 'saved', JSON.stringify(result));
    assert.deepEqual(created, ['anthropic/claude-opus-5-5/test-key']);
    const { record, workoutDir, testCmd } = result.status === 'saved' ? result : assert.fail();
    assert.match(record.id, /^drill_\d{8}_tie-breaker$/);
    assert.equal(testCmd, 'node --experimental-strip-types --no-warnings=ExperimentalWarning --test --test-reporter=tap kata.test.ts');

    const drillOutput = goodDrill();
    assert.equal(await readFile(join(workoutDir, 'kata.ts'), 'utf8'), drillOutput.startingCode);
    assert.equal(await readFile(join(workoutDir, 'kata.test.ts'), 'utf8'), drillOutput.testSuiteCode);
    assert.equal(await readFile(join(workoutDir, '.solution', 'kata.ts'), 'utf8'), drillOutput.referenceSolution);

    const saved: WorkoutRecord = await readJson(join(workoutDir, 'workout.json'));
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout;
    assert.deepEqual(saved.source, { path: 'src/queue.ts', commit: head, dirty: false });
    assert.deepEqual(saved.sourceAnchors, [{ path: 'src/queue.ts', startLine: 1, endLine: 3, explanation: 'The scheduler picks the next job here.', commit: head }]);
    assert.deepEqual(saved.hints, drillOutput.hints);

    const readme = await readFile(join(workoutDir, 'README.md'), 'utf8');
    assert.match(readme, /^# Late jobs jump the queue\n\n## Symptom/);
    assert.match(readme, /\[src\/queue\.ts:1-3\]\(\.\.\/\.\.\/\.\.\/src\/queue\.ts#L1-L3\)/);
    assert.match(readme, new RegExp(`Derived from commit \`${head.slice(0, 12)}\`\\.`));
    assert.doesNotMatch(readme, /Look at how ties are broken/, 'hints stay out of the README');

    // Consent is remembered, and the workspace stays invisible to git.
    assert.equal((await readJson(join(repo, '.fiu', 'config.json'))).consent.provider, 'anthropic');
    assert.equal((await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout, '');
  });

  it('asks for consent once per repository and provider', async () => {
    const repo = await repoWithSource();
    const questions: string[] = [];
    const confirm = async (message: string) => (questions.push(message), true);

    await run({ repo, confirm });
    assert.equal(questions.length, 1);
    assert.match(questions[0]!, /send src\/queue\.ts to anthropic \(claude-opus-5-5\)/);

    const second = await run({ repo, confirm });
    assert.equal(second.result.status, 'saved');
    assert.equal(questions.length, 1, 'not asked again');
    const ids = await readdir(join(repo, '.fiu', 'workouts'));
    assert.deepEqual(ids.sort(), [ids[0], `${ids[0]}-2`].sort(), 'the second Drill gets its own id');
  });

  it('sends nothing without consent', async () => {
    const repo = await repoWithSource();
    const declined = run({ repo, confirm: async () => false });
    await assert.rejects(declined, ConsentDeclinedError);
    await assert.rejects(run({ repo }), ConsentRequiredError, 'no terminal to ask in');
    assert.equal((await readJson(join(repo, '.fiu', 'config.json'))).consent, undefined);
  });

  it('fails on a missing API key before doing anything slow', async () => {
    const repo = await repoWithSource();
    await assert.rejects(run({ repo, env: {}, options: { yes: true } }), (error: Error) => {
      assert.ok(error instanceof MissingApiKeyError);
      assert.match(error.message, /run `fiu agent install claude`, then ask it to `\/fiu-drill src\/queue\.ts`/);
      return true;
    });
  });

  it('asks for a Quick Drill with --quick, and holds it to Quick size', async () => {
    const repo = await repoWithSource();
    const { result, prompts } = await run({
      repo,
      options: { yes: true, quick: true },
      replies: [goodDrill({ estimatedMinutes: 8 }), goodDrill({ estimatedMinutes: 4 })],
    });
    assert.match(prompts[0]!, /This is a Quick Drill/);
    assert.match(prompts[1]!, /\[schema\] a Quick Drill takes at most 5 minutes, not 8\./);
    assert.equal(result.status === 'saved' && result.record.estimatedMinutes, 4);
  });

  it('passes a pinned symbol to the model and records it', async () => {
    const repo = await repoWithSource();
    const { result, prompts } = await run({ repo, options: { yes: true }, target: 'src/queue.ts#pickNext' });
    assert.match(prompts[0]!, /Build the Drill around `pickNext`/);
    assert.equal(result.status === 'saved' && result.record.source.symbol, 'pickNext');
  });

  it('writes nothing when no Verified Drill can be produced', async () => {
    const repo = await repoWithSource();
    const { result } = await run({ repo, options: { yes: true }, replies: [goodDrill({ startingCode: TS_REFERENCE })] });
    assert.equal(result.status, 'failed');
    assert.deepEqual(await readdir(join(repo, '.fiu', 'workouts')), []);
  });

  it('marks Drills made from uncommitted code', async () => {
    const repo = await repoWithSource();
    await writeFile(join(repo, 'src', 'queue.ts'), `${TS_REFERENCE}\n// edited\n`);
    const { result } = await run({ repo, options: { yes: true } });
    const { workoutDir } = result.status === 'saved' ? result : assert.fail();
    assert.match(await readFile(join(workoutDir, 'README.md'), 'utf8'), /plus uncommitted changes/);
  });
});

describe('fiu kata', () => {
  it('generates, verifies, and saves a Kata with its brief', async () => {
    const repo = await repoWithSource();
    const { result, prompts } = await run({ repo, options: { yes: true, kind: 'kata' }, replies: [goodKata()], target: 'src/queue.ts#pickNext' });
    const { record, workoutDir } = result.status === 'saved' ? result : assert.fail(JSON.stringify(result));
    assert.match(prompts[0]!, /You create Katas/);
    assert.match(prompts[0]!, /Build the Kata around `pickNext`/);
    assert.match(record.id, /^kata_\d{8}_pick-next$/);

    const saved: WorkoutRecord = await readJson(join(workoutDir, 'workout.json'));
    assert.equal(saved.kind, 'kata');
    assert.equal(saved.gapSummary, goodKata().gapSummary);
    assert.equal(saved.regressionTestName, undefined);
    assert.equal(saved.injectedBugDescription, undefined);
    assert.equal(await readFile(join(workoutDir, 'kata.ts'), 'utf8'), goodKata().startingCode);
    assert.match(await readFile(join(workoutDir, 'README.md'), 'utf8'), /^# Choose the next job\n\n## What it must do/);
    assert.doesNotMatch(await readFile(join(workoutDir, 'README.md'), 'utf8'), /single pass keeping the best job/, 'the gapSummary stays internal');
  });

  it('asks consent naming a Kata', async () => {
    const repo = await repoWithSource();
    const asked: string[] = [];
    await run({ repo, options: { kind: 'kata' }, replies: [goodKata()], confirm: async (m) => (asked.push(m), true) });
    assert.match(asked[0]!, /to generate the Kata\./);
  });
});

describe('fiu predict', () => {
  /** Long enough (15+ lines) for the shortlist to consider it. */
  const LONG_QUEUE = `${TS_REFERENCE}${'\n// The scheduler serves the queue in this order.'.repeat(8)}\n`;
  async function repoWithLongSource(): Promise<string> {
    const repo = await tempGitRepo();
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'queue.ts'), LONG_QUEUE);
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
    return repo;
  }

  it('generates, verifies, and saves a Prediction whose README holds no answer', async () => {
    const repo = await repoWithSource();
    const { result, prompts } = await run({ repo, options: { yes: true, kind: 'prediction', questions: 1 }, replies: [goodPrediction()] });
    const { record, workoutDir } = result.status === 'saved' ? result : assert.fail(JSON.stringify(result));
    assert.match(record.id, /^prediction_\d{8}_tied-priorities$/);
    assert.match(prompts[0]!, /You create Predictions/);

    const saved: WorkoutRecord = await readJson(join(workoutDir, 'workout.json'));
    assert.equal(saved.kind, 'prediction');
    assert.equal(saved.prediction?.options.length, 4);
    assert.deepEqual(saved.hints, []);
    assert.deepEqual(saved.files, { code: '.solution/kata.ts', test: '.solution/kata.test.ts', solution: '.solution/kata.ts', originalTest: '.solution/kata.test.ts' });
    assert.ok(!existsSync(join(workoutDir, 'kata.ts')), 'there is no code to work on');

    const readme = await readFile(join(workoutDir, 'README.md'), 'utf8');
    assert.match(readme, /^# Who goes first on a tie\n\n## Scenario\n\nThree jobs are waiting\./);
    // Sorted, so the order the model wrote them in (correct first) gives nothing away.
    assert.match(readme, /## What happens\?\n\n- No job runs until the tie is resolved\.\n- The "early" job runs next\.\n- The "late" job runs next\.\n- The "low" job runs next\./);
    assert.doesNotMatch(readme, /first come, first served|You were picturing|scheduler picks/, 'explanation, misunderstandings, and anchors stay out');
  });

  it('picks a never-practised file when given a directory or nothing at all', async () => {
    const repo = await repoWithLongSource();
    const { result, steps } = await run({ repo, target: null, options: { yes: true, kind: 'prediction', questions: 1 }, replies: [goodPrediction()] });
    assert.ok(steps.includes('Asking about src/queue.ts'), steps.join('\n'));
    const { record } = result.status === 'saved' ? result : assert.fail(JSON.stringify(result));
    assert.equal(record.source.path, 'src/queue.ts');

    const paths = workspacePaths(repo);
    const { attempt } = await openAttempt(paths, await loadWorkout(paths, record.id), TYPESCRIPT);
    Object.assign(attempt.record, { outcome: 'completed', finishedAt: new Date().toISOString() });
    await saveAttempt(attempt);
    await assert.rejects(run({ repo, target: 'src', options: { yes: true, kind: 'prediction', questions: 1 }, replies: [goodPrediction()] }), /practised every file Fiu would pick in src/);
  });

  it('asks a Series of questions by default, each saved as its own Prediction', async () => {
    const repo = await repoWithSource();
    const { result, prompts } = await run({ repo, options: { yes: true, kind: 'prediction', questions: 2 }, replies: [goodSeries([tieQuestion(), urgentQuestion()])] });
    assert.match(prompts[0]!, /This is a Series: 2 Predictions/);
    const { series } = result.status === 'saved' ? result : assert.fail(JSON.stringify(result));
    assert.ok(series);
    assert.match(series.id, /^series_\d{8}_tied-priorities$/);
    assert.deepEqual(series.records.map((r) => [r.slug, r.series]), [
      ['tied-priorities', { id: series.id, index: 1, of: 2 }],
      ['urgent-first', { id: series.id, index: 2, of: 2 }],
    ]);
    const paths = workspacePaths(repo);
    const readme = await readFile(join(paths.workoutsDir, series.records[1]!.id, 'README.md'), 'utf8');
    assert.match(readme, /\*Question 2 of 2 about `src\/queue\.ts`\.\*/);
    const [spend] = (await readJson(paths.stateFile)).spend;
    assert.deepEqual(spend.workoutIds, series.records.map((r) => r.id));
    assert.equal(spend.workoutId, series.records[0]!.id);

    // The Series counts as attempted once any question is.
    assert.equal((await costReport(repo, startOfMonth())).neverAttempted.count, 1);
    const { attempt } = await openAttempt(paths, await loadWorkout(paths, series.records[1]!.id), TYPESCRIPT);
    await saveAttempt(attempt);
    assert.equal((await costReport(repo, startOfMonth())).attempted.count, 1);
  });

  it('uses the predictionQuestions setting', async () => {
    const repo = await repoWithSource();
    const home = await tempDir();
    await mkdir(join(home, '.config', 'fiu'), { recursive: true });
    await writeFile(join(home, '.config', 'fiu', 'config.json'), JSON.stringify({ predictionQuestions: 1 }));
    const scripted = scriptedModel(goodPrediction());
    const result = await drill(repo, 'src/queue.ts', { yes: true, sandbox: sandboxWorks, kind: 'prediction' }, { step: () => {}, warn: () => {} }, {
      createModel: () => ({ model: scripted.model, providerOptions: {} }),
      configEnv: { env: { ANTHROPIC_API_KEY: 'k' }, home },
      cacheRoot: await tempDir(),
    });
    assert.equal(result.status, 'saved');
    assert.doesNotMatch(scripted.prompts[0]!, /This is a Series/);
  });

  it('still takes a file for the other kinds only', async () => {
    const repo = await repoWithSource();
    await assert.rejects(run({ repo, target: 'src', options: { yes: true } }), /src is not a file/);
  });
});

describe('parseTarget', () => {
  it('splits file#symbol, but takes an existing path containing # literally', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'a.ts'), '');
    await writeFile(join(dir, 'c#.ts'), '');
    assert.deepEqual(parseTarget(dir, 'a.ts#run'), { file: join(dir, 'a.ts'), symbol: 'run' });
    assert.deepEqual(parseTarget(dir, 'c#.ts'), { file: join(dir, 'c#.ts'), symbol: undefined });
    assert.throws(() => parseTarget(dir, 'missing.ts'), DrillTargetError);
    assert.throws(() => parseTarget(dir, 'a.ts#'), /name a symbol/);
    assert.throws(() => parseTarget(dir, '.'), DrillTargetError);
  });

  it('refuses files outside the repository or inside the workspace', async () => {
    const repo = await repoWithSource();
    const outside = join(await tempDir(), 'x.ts');
    await writeFile(outside, '');
    await assert.rejects(run({ repo, target: outside }), /outside the repository/);
    await mkdir(join(repo, '.fiu', 'workouts', 'w'), { recursive: true });
    await writeFile(join(repo, '.fiu', 'workouts', 'w', 'kata.ts'), '');
    await assert.rejects(run({ repo, target: '.fiu/workouts/w/kata.ts' }), /not a Workout/);
    assert.ok(!existsSync(join(repo, '.fiu', 'workouts', 'w', 'workout.json')));
  });
});

describe('cost recording', () => {
  // The mock model reports 10 input and 20 output tokens per call as "mock-model-id": $0.05 per call at these prices.
  async function pricedRepo(): Promise<string> {
    const repo = await repoWithSource();
    await mkdir(join(repo, '.fiu'), { recursive: true });
    await writeFile(join(repo, '.fiu', 'config.json'), JSON.stringify({ prices: { 'mock-model-id': { input: 1000, output: 2000 } } }));
    return repo;
  }
  const ledger = async (repo: string) => (await readJson(join(repo, '.fiu', 'state.json'))).spend;

  it('records what a Workout cost in workout.json, its README, and the spend ledger', async () => {
    const repo = await pricedRepo();
    const { result } = await run({ repo, options: { yes: true }, replies: [goodDrill({ hints: ['one'] }), goodDrill()] });
    const { record, workoutDir, cost } = result.status === 'saved' ? result : assert.fail(JSON.stringify(result));

    assert.equal(cost.usd.toFixed(2), '0.10');
    const saved: WorkoutRecord = await readJson(join(workoutDir, 'workout.json'));
    assert.equal(saved.cost?.generationAttempts, 2);
    assert.deepEqual(saved.cost?.usage, [{ model: 'mock-model-id', inputTokens: 20, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
    assert.match(await readFile(join(workoutDir, 'README.md'), 'utf8'), /Generated for ≈ \$0\.10 over 2 attempts \(estimated with prices as of \d{4}-\d{2}\)\./);

    const [entry] = await ledger(repo);
    assert.deepEqual({ ...entry, at: undefined, cost: undefined }, {
      at: undefined,
      origin: 'manual',
      generator: 'fiu',
      source: 'src/queue.ts',
      result: 'verified',
      workoutId: record.id,
      generationAttempts: 2,
      cost: undefined,
    });
  });

  it('records spend that produced no Workout, including when the provider fails midway', async () => {
    const repo = await pricedRepo();
    const unverified = await run({ repo, options: { yes: true }, replies: [goodDrill({ startingCode: TS_REFERENCE })] });
    assert.equal(unverified.result.cost.usd.toFixed(2), '0.15');

    await run({ repo, options: { yes: true }, replies: [goodDrill({ worthPracticing: false, notWorthReason: 'Constants only.' })] });

    const outage = new APICallError({ message: 'overloaded', url: 'https://api', requestBodyValues: {}, statusCode: 529, isRetryable: true });
    // The AI SDK retries the overloaded call itself before giving up.
    await assert.rejects(run({ repo, options: { yes: true }, replies: [goodDrill({ hints: [] }), outage] }), /overloaded/);

    const entries = await ledger(repo);
    assert.deepEqual(
      entries.map((e: { result: string; generationAttempts: number; cost: { usd: number } }) => [e.result, e.generationAttempts, e.cost.usd.toFixed(2)]),
      [
        ['not-verified', 3, '0.15'],
        ['not-worth-practicing', 1, '0.05'],
        ['error', 1, '0.05'],
      ],
    );
    assert.deepEqual(await readdir(join(repo, '.fiu', 'workouts')), []);
  });

  it('shows the average cost of recent Drills once there is history', async () => {
    const repo = await pricedRepo();
    const first = await run({ repo, options: { yes: true } });
    assert.ok(!first.steps.some((s) => s.includes('averaged')));
    const second = await run({ repo, options: { yes: true } });
    assert.ok(second.steps.includes('Your Drills have averaged $0.05 (last 1)'), second.steps.join('\n'));
  });

  it('fiu cost splits spend into attempted, never attempted, and produced nothing', async () => {
    const repo = await pricedRepo();
    const saved = await run({ repo, options: { yes: true } });
    await run({ repo, options: { yes: true } });
    await run({ repo, options: { yes: true }, replies: [goodDrill({ startingCode: TS_REFERENCE })] });
    const paths = workspacePaths(repo);
    const id = saved.result.status === 'saved' ? saved.result.record.id : assert.fail();
    // Starting an Attempt is enough to count as attempted.
    await openAttempt(paths, await loadWorkout(paths, id), TYPESCRIPT);

    const report = await costReport(repo, startOfMonth());
    const usd = (b: { usd: number; count: number }) => [b.usd.toFixed(2), b.count];
    assert.deepEqual(usd(report.total), ['0.25', 3]);
    assert.deepEqual(usd(report.attempted), ['0.05', 1]);
    assert.deepEqual(usd(report.neverAttempted), ['0.05', 1]);
    assert.deepEqual(usd(report.producedNothing), ['0.15', 1]);
    assert.deepEqual(Object.keys(report.byOrigin), ['manual']);
    assert.deepEqual(usd(await costReport(repo, new Date(Date.now() + 60_000)).then((r) => r.total)), ['0.00', 0]);
  });

  it('reports tokens when the model has no known price', async () => {
    const repo = await repoWithSource();
    const { result } = await run({ repo, options: { yes: true } });
    assert.deepEqual(result.cost.unpricedModels, ['mock-model-id']);
    const report = await costReport(repo);
    assert.deepEqual(report.unpriced.map((u) => [u.model, u.inputTokens, u.outputTokens]), [['mock-model-id', 10, 20]]);
  });
});

describe(`fiu predict --rule (${sandboxWorks ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  const rule = 'When priorities tie, pickNext serves the job submitted first.';
  async function ruleRepo() {
    const repo = await repoWithSource();
    await writeUaFlows(repo, [{ name: 'Run jobs', domain: 'Scheduling', rules: [rule, 'Jobs are kept for 7 days.'], steps: [{ name: 'Pick', path: 'src/queue.ts' }] }]);
    return repo;
  }
  const ruleCheck = { agrees: true, note: 'On a tie, the job that arrived first runs first, as the rule says.' };

  it('finds the rule, proposes where it is enforced, asks, and saves the Prediction with the check', async () => {
    const repo = await ruleRepo();
    const asked: string[] = [];
    const confirm = async (m: string) => (asked.push(m), true);
    const { result, prompts } = await run({ repo, target: null, options: { kind: 'prediction', rule: 'priorities tie', yes: true }, replies: [goodPrediction({ ruleCheck })], confirm });
    assert.equal(result.status, 'saved', JSON.stringify(result));
    const record = result.status === 'saved' ? result.record : assert.fail();
    assert.deepEqual(record.rule, { text: rule, domain: 'Scheduling', ...ruleCheck });
    assert.equal(record.source.symbol, 'pickNext');
    assert.match(prompts[0]!, /Build the Scenario around this business rule/);
    assert.equal(result.series, undefined, 'one question, never a Series');
    // The listing shows it checked, where it was measured; the other rule, not yet.
    const { listRules } = await import('../src/commands/drill.ts');
    const listed = await listRules(repo, { configEnv: { env: {}, home: await tempDir() } });
    assert.deepEqual(listed.map((r) => [r.rule.text, r.agrees, r.target]), [
      [rule, true, 'src/queue.ts#pickNext'],
      ['Jobs are kept for 7 days.', undefined, undefined],
    ]);
  });

  it('asks before spending, and says where to point it when there is no terminal', async () => {
    const repo = await ruleRepo();
    const asked: string[] = [];
    const { result } = await run({ repo, target: null, options: { kind: 'prediction', rule: 'priorities tie' }, replies: [goodPrediction({ ruleCheck })], confirm: async (m) => (asked.push(m), true) });
    assert.equal(result.status, 'saved');
    assert.match(asked[0]!, /^Rule \(Understand-Anything\): "When priorities tie, pickNext serves the job submitted first\."\nIt looks enforced in src\/queue\.ts#pickNext \(the rule names it\)\. Ask about it there\?/);
    await assert.rejects(run({ repo, target: null, options: { kind: 'prediction', rule: 'priorities tie' } }), /looks enforced in src\/queue\.ts#pickNext\. Name it to go ahead: fiu predict src\/queue\.ts#pickNext --rule "priorities tie"/);
    await assert.rejects(run({ repo, target: null, options: { kind: 'prediction', rule: 'payments' } }), /No rule matches "payments"/);
    await assert.rejects(run({ repo, target: null, options: { kind: 'drill', rule: 'priorities tie' } }), /A rule is the topic of a Prediction/);
  });

  it('marks a check out of date once the code it measured changes, and the flow map says so', async () => {
    const repo = await ruleRepo();
    const configEnv = { env: {}, home: await tempDir() };
    const { result } = await run({ repo, target: null, options: { kind: 'prediction', rule: 'priorities tie', yes: true }, replies: [goodPrediction({ ruleCheck })] });
    assert.equal(result.status, 'saved');
    const { buildFlowMap, renderFlowMap } = await import('../src/map/flows.ts');
    const { listRules } = await import('../src/commands/drill.ts');

    let map = await buildFlowMap(repo, { configEnv });
    assert.deepEqual(map.domains.map((d) => [d.name, d.rules.map((r) => r.status), d.flows.map((f) => [f.name, f.files.map((x) => x.path)])]), [
      ['Scheduling', ['follows', 'unchecked'], [['Run jobs', ['src/queue.ts']]]],
    ]);
    assert.deepEqual(map.suggestions, [{ command: 'fiu predict --rule', why: '1 rule never checked against the code' }]);
    assert.match(renderFlowMap(map, { color: false }), /^Scheduling {3}rules: 1 ✓ {2}0 ✗ {2}0 ◐ {2}1 ·\n {2}Run jobs {2}0 of 1 file practised\n {4}[●·◐✓] src\/queue\.ts$/m);

    // A comment elsewhere in the file leaves the check standing; a change to pickNext does not.
    await writeFile(join(repo, 'src', 'queue.ts'), `// The scheduler.\n${TS_REFERENCE}`);
    assert.equal((await listRules(repo, { configEnv }))[0]!.stale, false);
    await writeFile(join(repo, 'src', 'queue.ts'), TS_REFERENCE.replace('job.at < best.at', 'job.at > best.at'));
    const [listed] = await listRules(repo, { configEnv });
    assert.deepEqual([listed!.agrees, listed!.stale, listed!.staleReason], [true, true, 'pickNext changed']);

    map = await buildFlowMap(repo, { configEnv });
    assert.equal(map.domains[0]!.rules[0]!.status, 'stale');
    assert.deepEqual(map.suggestions[0], { command: `fiu predict src/queue.ts#pickNext --rule "${rule}"`, why: 'checked before pickNext changed' });
    assert.match(renderFlowMap(map, { color: false }), /◐ "When priorities tie, pickNext serves the job submitted first\." → src\/queue\.ts#pickNext \(pickNext changed\)/);
  });

  it('says there are no rules without a domain graph', async () => {
    await assert.rejects(run({ repo: await repoWithSource(), target: null, options: { kind: 'prediction', rule: 'anything' } }), /no Understand-Anything business rules/);
  });
});
