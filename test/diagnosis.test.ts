import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { execa } from 'execa';
import { drill } from '../src/commands/drill.ts';
import { train, type TrainIo } from '../src/commands/train.ts';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { preflight } from '../src/languages/run.ts';
import { answerStats } from '../src/map/stats.ts';
import { renderStats } from '../src/map/render.ts';
import { openSandbox } from '../src/sandbox/sandbox.ts';
import { fetchWorkouts, share } from '../src/sharing/share.ts';
import { checkWorkoutOutput, type DiagnosisOutput } from '../src/synthesis/schema.ts';
import { findOriginalDefect } from '../src/verify/defect.ts';
import { verify, type Candidate } from '../src/verify/gate.ts';
import { nextQuickWorkout } from '../src/workouts/queue.ts';
import { saveDrill, sourceRevision } from '../src/workouts/save.ts';
import { listWorkouts } from '../src/workouts/store.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';
import { goodDiagnosis, scriptedModel, TS_DIAGNOSIS_TESTS, TS_REFERENCE } from './mock-model.ts';

const sandbox = await openSandbox({ allowUnsandboxed: true });
const cacheRoot = await tempDir();
after(() => sandbox.dispose());

const causes = goodDiagnosis().causes;
const withCause = (i: number, change: Partial<DiagnosisOutput['causes'][number]>) => goodDiagnosis({ causes: causes.map((c, j) => (j === i ? { ...c, ...change } : c)) });
const candidate = (d: DiagnosisOutput, source?: string): Candidate => ({ kind: 'diagnosis', referenceSolution: d.referenceSolution, testSuiteCode: d.testSuiteCode, causes: d.causes, ...(source ? { source, lineComment: '//' } : {}) });

describe('checkWorkoutOutput for Diagnoses', () => {
  const check = (d: DiagnosisOutput) => checkWorkoutOutput('diagnosis', d, 20);
  it('accepts a well-formed Diagnosis', () => assert.deepEqual(check(goodDiagnosis()), []));
  it('needs four Causes, one true, each with its own test, Symptom, and Variant', () => {
    assert.match(check(goodDiagnosis({ causes: causes.slice(0, 3) })).join(), /exactly 4 Causes, not 3/);
    assert.match(check(withCause(1, { correct: true })).join(), /exactly one Cause must be correct, not 2/);
    assert.match(check(withCause(1, { testName: causes[0]!.testName })).join(), /is used by another Cause/);
    assert.match(check(withCause(1, { symptom: causes[0]!.symptom })).join(), /the same as another Cause's/);
    assert.match(check(withCause(0, { variant: { original: '', changed: '' } })).join(), /every Cause needs a Variant, the true one too/);
    assert.match(check(withCause(0, { variant: { original: 'not there', changed: 'x' } })).join(), /occurs 0 times/);
  });
  it('keeps names from the code out of Causes and Symptoms', () => {
    assert.match(check(withCause(0, { text: 'The pickNext function is wrong.' })).join(), /Cause 1's text uses names from the code \(pickNext\)/);
    assert.match(check(withCause(0, { symptom: 'pickNext returned the wrong job.' })).join(), /Cause 1's symptom uses names from the code \(pickNext\)/);
  });
  it('holds every Diagnosis to five minutes', () => assert.match(check(goodDiagnosis({ estimatedMinutes: 10 })).join(), /between 2 and 5/));
});

describe(`verify for Diagnoses (${sandbox.isolated ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  it('runs all five versions of a well-formed Diagnosis', async () => {
    await preflight(sandbox, TYPESCRIPT, cacheRoot);
    const result = await verify(candidate(goodDiagnosis()), TYPESCRIPT, sandbox, { cacheRoot });
    assert.ok(result.verified, JSON.stringify(result));
    assert.equal(result.variantRuns?.length, 4);
  });

  it('rejects a Symptom the healthy code already shows', async () => {
    const tests = TS_DIAGNOSIS_TESTS.replace("assert.equal(pickNext(jobs), 'queue-full')", "assert.equal(pickNext(jobs), 'early')");
    const result = await verify(candidate(goodDiagnosis({ testSuiteCode: tests })), TYPESCRIPT, sandbox, { cacheRoot });
    assert.equal(result.verified, false);
    assert.match(JSON.stringify(!result.verified && result.failures), /every Symptom test must fail against it by assertion: Cause 4's test passes/);
  });

  it('rejects a Cause that changes nothing the tests can see', async () => {
    const result = await verify(candidate(withCause(3, { variant: { original: 'return best?.id;', changed: 'return best?.id ;' } })), TYPESCRIPT, sandbox, { cacheRoot });
    assert.equal(result.verified, false);
    assert.match(JSON.stringify(!result.verified && result.failures), /Against Cause 4's Variant, only option 4's test may pass/);
  });

  it('allows the true Cause to be in the source, but not a wrong one', async () => {
    const trueInSource = TS_REFERENCE.replace('job.at < best.at', 'job.at > best.at');
    assert.ok((await verify(candidate(goodDiagnosis(), trueInSource), TYPESCRIPT, sandbox, { cacheRoot })).verified);
    const wrongInSource = TS_REFERENCE.replace('job.priority > best.priority', 'job.priority < best.priority');
    const result = await verify(candidate(goodDiagnosis(), wrongInSource), TYPESCRIPT, sandbox, { cacheRoot });
    assert.match(JSON.stringify(!result.verified && result.failures), /Cause 2 is what the source does/);
  });
});

describe('when a Diagnosis may be real', () => {
  it('finds the true Cause in the source', () => {
    const source = TS_REFERENCE.replace('job.at < best.at', 'job.at > best.at');
    const defect = findOriginalDefect('diagnosis', goodDiagnosis(), source, '//');
    assert.equal(defect?.evidence, 'source');
    assert.equal(defect?.description, 'Ties in priority go to the most recently submitted job.');
    assert.equal(findOriginalDefect('diagnosis', goodDiagnosis(), TS_REFERENCE, '//'), undefined);
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
  /** The key for a Cause, as shown in this Attempt's shuffled order. */
  static keyFor(printed: string, text: string) { return printed.match(new RegExp(`\\[(\\d)\\] ${text}`))![1]!; }
}

async function repoWithDiagnosis(source = TS_REFERENCE) {
  const repo = await tempGitRepo();
  await writeFile(join(repo, 'queue.ts'), source);
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
  const paths = workspacePaths(repo);
  await ensureWorkspace(paths);
  const record = await saveDrill({ paths, profile: TYPESCRIPT, drill: goodDiagnosis(), kind: 'diagnosis', sourcePath: 'queue.ts', source, revision: await sourceRevision(repo, 'queue.ts'), generationAttempts: 1 });
  return { repo, paths, record };
}

/** Answers through the real runner: finds the shown key for `text` first. */
async function answer(repo: string, id: string, text: string, ...then: string[]) {
  const configEnv = { env: {}, home: await tempDir() };
  const peek = new Keys('q');
  await train(repo, id, { sandbox: false }, peek, { configEnv, cacheRoot });
  const io = new Keys(Keys.keyFor(peek.printed[0]!, text), ...then);
  const result = await train(repo, id, { sandbox: false }, io, { configEnv, cacheRoot });
  return { result, io, shown: peek.printed[0]! };
}

describe('answering a Diagnosis', () => {
  it('labels the incident as practice, and never shows the answer in the README', async () => {
    const { paths, record } = await repoWithDiagnosis();
    assert.equal(record.diagnosis?.causes.length, 4);
    const readme = await readFile(join(paths.workoutsDir, record.id, 'README.md'), 'utf8');
    assert.match(readme, /\*Practice incident: this didn't happen\. The code here was changed on purpose\.\*/);
    assert.match(readme, /## What happened\n\nTwo jobs had the same priority/);
    assert.doesNotMatch(readme, /correct|arrival times decide/);
    assert.deepEqual(record.files.code, record.files.solution);
  });

  it('completes on the true Cause, recording how sure the human was', async () => {
    const { repo, record, paths } = await repoWithDiagnosis();
    const { result, io, shown } = await answer(repo, record.id, 'Ties in priority go', '3');
    assert.match(shown, /Practice incident: this didn't happen\.[^]*Two jobs had the same priority[^]*What explains it\?/);
    assert.equal(result.status, 'completed', io.text);
    assert.match(io.text, /Right: Ties in priority go to the most recently submitted job\.\n\nWhen priorities tie[^]*Where this lives:\n {2}queue\.ts:3-9/);
    assert.equal(JSON.parse(await readFile(paths.stateFile, 'utf8')).outcomes[0].confidence, 'certain');
  });

  it('on a wrong answer, says what that Cause would have shown instead, and shows the code difference', async () => {
    const { repo, record } = await repoWithDiagnosis();
    const { result, io } = await answer(repo, record.id, 'Queues of more than two', '1', 'd');
    assert.equal(result.status, 'abandoned');
    assert.match(io.text, /Not quite\. The cause: Ties in priority go[^]*Your answer would have shown up differently: With three jobs waiting, users were told the queue is full\./);
    assert.match(io.text, /The code was changed like this to cause the incident:\n@@ line \d+ @@\n- .*job\.at < best\.at[^]*\+ .*job\.at > best\.at/);
  });

  it('follows with the notice when the bug may be real', async () => {
    const { repo, record } = await repoWithDiagnosis(TS_REFERENCE.replace('job.at < best.at', 'job.at > best.at'));
    const { io } = await answer(repo, record.id, 'Ties in priority go', 'x');
    assert.match(io.text, /⚠ This bug may be real: queue\.ts:\d+/);
  });

  it('is Quick by its own rules, and counts toward kin stats and Blind Spots', async () => {
    const { repo, record, paths } = await repoWithDiagnosis();
    assert.equal((await nextQuickWorkout(paths, ['diagnosis']))?.record.id, record.id);
    await answer(repo, record.id, 'Queues of more than two', '3', 'x');
    const stats = await answerStats(repo);
    assert.deepEqual(stats.byKind, [{ kind: 'diagnosis', answers: 1, right: 0 }]);
    assert.deepEqual(stats.blindSpots.map((b) => b.path), ['queue.ts']);
    assert.match(renderStats(stats, { color: false }), /^Your answers: — right \(0 of 1/);
  });
});

describe('kin diagnose', () => {
  it('generates, verifies, and saves a Diagnosis, picking a file from a directory', async () => {
    const repo = await tempGitRepo();
    const padded = `${TS_REFERENCE}${Array.from({ length: 10 }, (_, i) => `export const pad${i} = (x: number) => (x > ${i} ? x : ${i});`).join('\n')}\n`;
    await writeFile(join(repo, 'queue.ts'), padded);
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
    const scripted = scriptedModel(goodDiagnosis() as never);
    const result = await drill(repo, undefined, { yes: true, sandbox: sandbox.isolated, kind: 'diagnosis' }, { step: () => {}, warn: () => {} }, {
      createModel: () => ({ model: scripted.model, providerOptions: {} }),
      configEnv: { env: { ANTHROPIC_API_KEY: 'k' }, home: await tempDir() },
      cacheRoot,
    });
    assert.equal(result.status, 'saved', JSON.stringify(result));
    assert.match(scripted.prompts[0]!, /You create Diagnoses/);
    assert.equal(result.status === 'saved' && result.record.kind, 'diagnosis');
  });
});

describe('sharing a Diagnosis', () => {
  it('re-verifies all five versions on fetch', async () => {
    const origin = await tempDir();
    await execa('git', ['init', '-q', '--bare'], { cwd: origin });
    const clone = async (name: string) => {
      const dir = join(await tempDir(), name);
      await execa('git', ['clone', '-q', origin, dir]);
      await execa('git', ['config', 'user.name', name], { cwd: dir });
      await execa('git', ['config', 'user.email', `${name}@team.dev`], { cwd: dir });
      await ensureWorkspace(workspacePaths(dir));
      await excludeWorkspaceFromGit(dir);
      return dir;
    };
    const alice = await clone('alice');
    await writeFile(join(alice, 'queue.ts'), TS_REFERENCE);
    await execa('git', ['add', 'queue.ts'], { cwd: alice });
    await execa('git', ['commit', '-qm', 'queue'], { cwd: alice });
    await execa('git', ['push', '-q', 'origin', 'HEAD'], { cwd: alice });
    const record = await saveDrill({ paths: workspacePaths(alice), profile: TYPESCRIPT, drill: goodDiagnosis(), kind: 'diagnosis', sourcePath: 'queue.ts', revision: await sourceRevision(alice, 'queue.ts'), generationAttempts: 1 });
    await share(alice, [record.id]);
    const bob = await clone('bob');
    const fetched = await fetchWorkouts(bob, { sandbox: sandbox.isolated }, () => {}, { configEnv: { env: {}, home: await tempDir() }, cacheRoot });
    assert.deepEqual(fetched.rejected, []);
    assert.deepEqual(fetched.imported.map((i) => i.id), [record.id]);
    assert.equal((await listWorkouts(workspacePaths(bob)))[0]!.record.kind, 'diagnosis');
  });
});
