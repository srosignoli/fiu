import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { execa } from 'execa';
import { writeAtlas, emptyAtlas } from '../src/atlas/store.ts';
import { buildSkeleton } from '../src/atlas/skeleton.ts';
import { drill, DrillTargetError, type DrillUi } from '../src/commands/drill.ts';
import { train, type TrainIo } from '../src/commands/train.ts';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { profiles } from '../src/languages/registry.ts';
import { preflight } from '../src/languages/run.ts';
import { openSandbox } from '../src/sandbox/sandbox.ts';
import { checkWorkoutOutput, type WhatIfOutput } from '../src/synthesis/schema.ts';
import { verify, type Candidate } from '../src/verify/gate.ts';
import { workspacePaths, ensureWorkspace } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';
import { goodWhatIf, scriptedModel, TS_BEFORE_COMMIT, TS_REFERENCE } from './mock-model.ts';

const sandbox = await openSandbox({ allowUnsandboxed: true });
const cacheRoot = await tempDir();
after(() => sandbox.dispose());

const SENTENCE = 'let the first job win a tie';

describe('checkWorkoutOutput for What-ifs', () => {
  const check = (w: WhatIfOutput) => checkWorkoutOutput('prediction', w, 20, { whatIf: true });
  it('accepts a well-formed What-if', () => assert.deepEqual(check(goodWhatIf()), []));
  it('needs its reading of the change, today\'s code, and exactly one option for today', () => {
    assert.match(check(goodWhatIf({ modelledAs: ' ' })).join(), /modelledAs is empty/);
    assert.match(check(goodWhatIf({ previous: '' })).join(), /give the unit as it is today/);
    const options = goodWhatIf().options.map((o) => ({ ...o, previous: false }));
    assert.match(check(goodWhatIf({ options })).join(), /what happens today \(previous: true\), not 0/);
  });
  it('keeps names from the code out of its reading', () => {
    assert.match(check(goodWhatIf({ modelledAs: 'pickNext prefers the first job.' })).join(), /modelledAs uses names from the code \(pickNext\)/);
  });
});

describe(`verify for What-ifs (${sandbox.isolated ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  const candidate = (w: WhatIfOutput, source = TS_BEFORE_COMMIT): Candidate => ({
    kind: 'prediction', whatIf: true, referenceSolution: w.referenceSolution, testSuiteCode: w.testSuiteCode, options: w.options, previous: w.previous,
    source, sourceBefore: source, sourceAfter: w.referenceSolution, lineComment: '//',
  });
  it('measures the changed code, today\'s code, and two Variants', async () => {
    await preflight(sandbox, TYPESCRIPT, cacheRoot);
    const result = await verify(candidate(goodWhatIf()), TYPESCRIPT, sandbox, { cacheRoot });
    assert.ok(result.verified, JSON.stringify(result));
    assert.equal(result.variantRuns?.length, 3);
  });
  it('rejects a today the source file does not have', async () => {
    const result = await verify(candidate(goodWhatIf(), TS_REFERENCE.replace('job.at < best.at', 'job.at <= best.at')), TYPESCRIPT, sandbox, { cacheRoot });
    assert.match(JSON.stringify(!result.verified && result.failures), /is not in the source file/);
  });
  it('rejects a change of more than 10 lines', async () => {
    const padding = Array.from({ length: 11 }, (_, i) => `export const today${i} = ${i};`).join('\n');
    const result = await verify(candidate(goodWhatIf({ previous: `${TS_BEFORE_COMMIT}\n${padding}\n` })), TYPESCRIPT, sandbox, { cacheRoot });
    assert.match(JSON.stringify(!result.verified && result.failures), /a What-if models at most 10/);
  });
});

async function repo() {
  const dir = await tempGitRepo();
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'queue.ts'), TS_BEFORE_COMMIT);
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

async function make(dir: string, target: string | undefined, whatIf: string | true, replies: Parameters<typeof scriptedModel>, confirm?: DrillUi['confirm'], yes = true) {
  const scripted = scriptedModel(...replies);
  const result = await drill(dir, target, { yes, sandbox: sandbox.isolated, kind: 'prediction', whatIf }, { step: () => {}, warn: () => {}, confirm }, {
    createModel: () => ({ model: scripted.model, providerOptions: {} }),
    configEnv: { env: { ANTHROPIC_API_KEY: 'k' }, home: await tempDir() },
    cacheRoot,
  });
  return { result, prompts: scripted.prompts };
}

describe('fiu predict --what-if', () => {
  it('models the sentence, saves its reading beside it, and leaves the repository alone', async () => {
    const dir = await repo();
    const { result, prompts } = await make(dir, 'src/queue.ts', SENTENCE, [goodWhatIf()]);
    assert.match(prompts[0]!, /This is a What-if/);
    assert.match(prompts[0]!, /The Proposed Change, in the human's words: \\"let the first job win a tie\\"/);
    assert.doesNotMatch(prompts[0]!, /This is a Series/);
    const { record } = result.status === 'saved' ? result : assert.fail(JSON.stringify(result));
    assert.deepEqual(record.whatIf, { sentence: SENTENCE, modelled: 'When two jobs tie on priority, the one that arrived first runs.' });
    const readme = await readFile(join(workspacePaths(dir).workoutsDir, record.id, 'README.md'), 'utf8');
    assert.match(readme, /Imagine this change: let the first job win a tie\nModelled as: When two jobs tie/);
    assert.equal(await readFile(join(dir, 'src', 'queue.ts'), 'utf8'), TS_BEFORE_COMMIT);
    assert.equal((await execa('git', ['status', '--porcelain', 'src'], { cwd: dir })).stdout, '');
  });

  it('asks the model to propose a change when given no sentence', async () => {
    const dir = await repo();
    const { result, prompts } = await make(dir, 'src/queue.ts', true, [goodWhatIf()]);
    assert.match(prompts[0]!, /Propose one small change/);
    assert.equal(result.status === 'saved' && result.record.whatIf?.sentence, undefined);
  });

  it('says why when the change does not fit, without a fallback', async () => {
    const dir = await repo();
    const { result, prompts } = await make(dir, 'src/queue.ts', 'retry failed payments', [goodWhatIf({ worthPracticing: false, notWorthReason: 'Payments are not in this file.' })]);
    assert.deepEqual([result.status, result.status === 'not-worth-practicing' && result.reason], ['not-worth-practicing', 'Payments are not in this file.']);
    assert.equal(prompts.length, 1);
  });

  it('finds the file through the Atlas search, confirming before spending anything', async () => {
    const dir = await repo();
    const paths = workspacePaths(dir);
    await ensureWorkspace(paths);
    const skeleton = await buildSkeleton(dir, profiles());
    const atlas = emptyAtlas();
    atlas.files['src/queue.ts'] = { hash: skeleton.files.get('src/queue.ts')!.hash, text: 'Chooses which waiting job runs.', writtenAt: '2026-11-01T00:00:00.000Z', functions: {} };
    await writeAtlas(paths, atlas);

    const asked: string[] = [];
    const declined = make(dir, undefined, 'which waiting job runs', [goodWhatIf()], async (m) => (asked.push(m), false), false);
    await assert.rejects(declined, DrillTargetError);
    assert.match(asked[0]!, /The closest match for "which waiting job runs" is src\/queue\.ts/);

    const { prompts } = await make(dir, undefined, 'which waiting job runs', [goodWhatIf()]);
    assert.match(prompts[0]!, /Source file: src\/queue\.ts/);
    await assert.rejects(make(dir, undefined, 'payments', [goodWhatIf()]), /Nothing matches "payments"/);
  });
});

class Keys implements TrainIo {
  printed: string[] = [];
  keys: string[];
  constructor(...keys: string[]) { this.keys = keys; }
  print(text: string) { this.printed.push(text); }
  async readKey() { return this.keys.shift(); }
  async pick() { return undefined; }
  async rate() { return undefined; }
  async confirmDefect() { return undefined; }
  get text() { return this.printed.join('\n'); }
}

async function answer(dir: string, id: string, text: string, ...then: string[]) {
  const configEnv = { env: {}, home: await tempDir() };
  const peek = new Keys('q');
  await train(dir, id, { sandbox: false }, peek, { configEnv, cacheRoot });
  const key = peek.printed[0]!.match(new RegExp(`\\[(\\d)\\] ${text}`))![1]!;
  const io = new Keys(key, ...then);
  return { result: await train(dir, id, { sandbox: false }, io, { configEnv, cacheRoot }), io, shown: peek.printed[0]! };
}

describe('answering a What-if', () => {
  const saved = async () => {
    const dir = await repo();
    const { result } = await make(dir, 'src/queue.ts', SENTENCE, [goodWhatIf()]);
    return { dir, id: result.status === 'saved' ? result.record.id : assert.fail(JSON.stringify(result)) };
  };

  it('shows the sentence and its reading first, then both sides and what was measured', async () => {
    const { dir, id } = await saved();
    const { result, io, shown } = await answer(dir, id, 'The "early" job', '3', 'x');
    assert.match(shown, /Imagine this change: let the first job win a tie\nModelled as: When two jobs tie[^]*Three jobs are waiting/);
    assert.equal(result.status, 'completed');
    assert.match(io.text, /Right\.\n\nToday: The "late" job runs next\.\nWith this change: The "early" job runs next\./);
    assert.match(io.text, /Measured on a self-contained copy of this unit, not your whole system\. Nothing in your repository changed\./);
  });

  it('offers the code change after a right answer too, and names today\'s behaviour as such', async () => {
    const right = await saved();
    const { io } = await answer(right.dir, right.id, 'The "early" job', '2', 'd');
    assert.match(io.text, /The change, as modelled \(- today, \+ with it\):\n@@ line \d+ @@\n- .*job\.at > best\.at[^]*\+ .*job\.at < best\.at/);

    const wrong = await saved();
    const { result, io: wrongIo } = await answer(wrong.dir, wrong.id, 'The "late" job', '3', 'x');
    assert.equal(result.status, 'abandoned');
    assert.match(wrongIo.text, /Not quite\.\nThat is what happens today, and this change alters it\./);
  });
});
