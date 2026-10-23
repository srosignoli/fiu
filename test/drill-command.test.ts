import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { drill, DrillTargetError, parseTarget, type DrillCommandOptions, type DrillUi } from '../src/commands/drill.ts';
import { ConsentDeclinedError, ConsentRequiredError } from '../src/consent.ts';
import { MissingApiKeyError } from '../src/credentials.ts';
import { openSandbox, SandboxUnavailableError } from '../src/sandbox/sandbox.ts';
import type { WorkoutRecord } from '../src/workouts/save.ts';
import { tempDir, tempGitRepo } from './helpers.ts';
import { goodDrill, scriptedModel, TS_REFERENCE } from './mock-model.ts';

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
  target?: string;
}

async function run({ repo, options = {}, confirm, env = { ANTHROPIC_API_KEY: 'test-key' }, replies = [goodDrill()], target = 'src/queue.ts' }: Run) {
  const scripted = scriptedModel(...replies);
  const steps: string[] = [];
  const created: string[] = [];
  const result = await drill(
    repo,
    target,
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

describe('kin drill', () => {
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
    assert.equal((await readJson(join(repo, '.kintsugi', 'config.json'))).consent.provider, 'anthropic');
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
    const ids = await readdir(join(repo, '.kintsugi', 'workouts'));
    assert.deepEqual(ids.sort(), [ids[0], `${ids[0]}-2`].sort(), 'the second Drill gets its own id');
  });

  it('sends nothing without consent', async () => {
    const repo = await repoWithSource();
    const declined = run({ repo, confirm: async () => false });
    await assert.rejects(declined, ConsentDeclinedError);
    await assert.rejects(run({ repo }), ConsentRequiredError, 'no terminal to ask in');
    assert.equal((await readJson(join(repo, '.kintsugi', 'config.json'))).consent, undefined);
  });

  it('fails on a missing API key before doing anything slow', async () => {
    const repo = await repoWithSource();
    await assert.rejects(run({ repo, env: {}, options: { yes: true } }), MissingApiKeyError);
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
    assert.deepEqual(await readdir(join(repo, '.kintsugi', 'workouts')), []);
  });

  it('marks Drills made from uncommitted code', async () => {
    const repo = await repoWithSource();
    await writeFile(join(repo, 'src', 'queue.ts'), `${TS_REFERENCE}\n// edited\n`);
    const { result } = await run({ repo, options: { yes: true } });
    const { workoutDir } = result.status === 'saved' ? result : assert.fail();
    assert.match(await readFile(join(workoutDir, 'README.md'), 'utf8'), /plus uncommitted changes/);
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
    await mkdir(join(repo, '.kintsugi', 'workouts', 'w'), { recursive: true });
    await writeFile(join(repo, '.kintsugi', 'workouts', 'w', 'kata.ts'), '');
    await assert.rejects(run({ repo, target: '.kintsugi/workouts/w/kata.ts' }), /not a Workout/);
    assert.ok(!existsSync(join(repo, '.kintsugi', 'workouts', 'w', 'workout.json')));
  });
});
