import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import type { TestRun } from '../src/languages/profile.ts';
import { preflight } from '../src/languages/run.ts';
import { openSandbox } from '../src/sandbox/sandbox.ts';
import { checkWorkoutOutput, codeVocabulary, type PredictionOutput } from '../src/synthesis/schema.ts';
import { buildVariant, checkOptionTests, checkOutcomes, verify, type Candidate } from '../src/verify/gate.ts';
import { tempDir } from './helpers.ts';
import { goodPrediction, TS_REFERENCE } from './mock-model.ts';

const run = (...tests: [string, TestRun['tests'][number]['outcome']][]): TestRun => ({
  ran: true,
  tests: tests.map(([name, outcome]) => ({ name, outcome })),
  output: 'runner output',
});
const options = goodPrediction().options;
const withOption = (i: number, change: Partial<PredictionOutput['options'][number]>) =>
  goodPrediction({ options: options.map((o, j) => (j === i ? { ...o, ...change } : o)) });

describe('checkWorkoutOutput for Predictions', () => {
  it('accepts a well-formed Prediction', () => {
    assert.deepEqual(checkWorkoutOutput('prediction', goodPrediction(), 10), []);
  });

  it('needs four options, exactly one of them correct and without a Variant', () => {
    assert.match(checkWorkoutOutput('prediction', goodPrediction({ options: options.slice(0, 3) }), 10).join(), /exactly 4 options, not 3/);
    assert.match(checkWorkoutOutput('prediction', withOption(1, { correct: true }), 10).join(), /exactly one option must be correct, not 2/);
    assert.match(checkWorkoutOutput('prediction', withOption(0, { variant: options[1]!.variant }), 10).join(), /option 1 is the correct one, so it has no Variant/);
  });

  it('needs each wrong option to replace text found exactly once, and to say what it stands for', () => {
    assert.match(checkWorkoutOutput('prediction', withOption(1, { variant: { original: 'nowhere', changed: 'x' } }), 10).join(), /option 2's variant\.original occurs 0 times/);
    assert.match(checkWorkoutOutput('prediction', withOption(1, { variant: { original: 'best', changed: 'x' } }), 10).join(), /occurs \d+ times/);
    assert.match(checkWorkoutOutput('prediction', withOption(2, { misunderstanding: ' ' }), 10).join(), /option 3's misunderstanding is empty/);
    assert.match(checkWorkoutOutput('prediction', withOption(3, { testName: 'runs the late job' }), 10).join(), /used by another option/);
  });

  it('keeps names from the code out of the Scenario and options, but not the explanation', () => {
    assert.deepEqual([...codeVocabulary(TS_REFERENCE)], ['pickNext']);
    assert.deepEqual([...codeVocabulary('def normalize_context(tags): max_len = 3\nclass TagIndex: id = 1')], ['normalize_context', 'max_len', 'TagIndex']);
    const leaky = goodPrediction({ scenario: 'pickNext is called on three jobs. What does it return?' });
    assert.match(checkWorkoutOutput('prediction', leaky, 10).join(), /the scenario uses names from the code \(pickNext\)/);
    assert.match(checkWorkoutOutput('prediction', withOption(1, { text: 'pickNext returns "late".' }), 10).join(), /option 2's text uses names from the code/);
    assert.deepEqual(checkWorkoutOutput('prediction', goodPrediction({ explanation: 'pickNext keeps the best job so far.' }), 10), []);
  });

  it('holds every Prediction to five minutes', () => {
    assert.match(checkWorkoutOutput('prediction', goodPrediction({ estimatedMinutes: 8 }), 10).join(), /between 2 and 5, not 8/);
  });
});

describe('the Prediction gate checks', () => {
  const names = options.map((o) => o.testName);
  const outcomes = (passing: number) => run(...names.map((n, i): [string, 'pass' | 'assertion-failure'] => [`what runs next > ${n}`, i === passing ? 'pass' : 'assertion-failure']));

  it('need one test per option, and no others', () => {
    assert.deepEqual(checkOptionTests(options, outcomes(0)), []);
    assert.match(checkOptionTests(options, run(...names.slice(0, 3).map((n): [string, 'pass'] => [n, 'pass'])))[0]!.message, /option 4's test "runs no job" doesn't exist/);
    assert.match(checkOptionTests(options, run(...names.map((n): [string, 'pass'] => [n, 'pass']), ['extra', 'pass']))[0]!.message, /belong to no option: "extra"/);
  });

  it('need exactly the expected option to pass, the rest to fail by assertion', () => {
    assert.deepEqual(checkOutcomes(options, 2, "option 3's Variant", outcomes(2)), []);
    assert.match(checkOutcomes(options, 0, 'the Reference Solution', outcomes(1))[0]!.message, /option 1's test fails, but it must pass; option 2's test passes too/);
    const crash = run(...names.map((n, i): [string, 'pass' | 'error' | 'assertion-failure'] => [n, i === 0 ? 'pass' : i === 3 ? 'error' : 'assertion-failure']));
    assert.match(checkOutcomes(options, 0, 'the Reference Solution', crash)[0]!.message, /option 4's test crashes/);
  });

  it('build each Variant from its snippet', () => {
    assert.equal(buildVariant(TS_REFERENCE, options[1]!.variant), TS_REFERENCE.replace('job.at < best.at', 'job.at > best.at'));
    assert.equal(buildVariant('a $& b', { original: 'b', changed: '$&$&' }), 'a $& $&$&', 'replacement text is taken literally');
  });
});

const sandbox = await openSandbox({ allowUnsandboxed: true });
const cacheRoot = await tempDir();
after(() => sandbox.dispose());
const candidate = (prediction: PredictionOutput, extra: Partial<Candidate> = {}): Candidate => ({
  kind: 'prediction',
  referenceSolution: prediction.referenceSolution,
  testSuiteCode: prediction.testSuiteCode,
  options: prediction.options,
  ...extra,
});

describe(`verify for Predictions (${sandbox.isolated ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  it('verifies a well-formed Prediction, running every Variant', async () => {
    await preflight(sandbox, TYPESCRIPT, cacheRoot);
    const result = await verify(candidate(goodPrediction()), TYPESCRIPT, sandbox, { cacheRoot });
    assert.ok(result.verified, JSON.stringify(result));
    assert.equal(result.variantRuns?.length, 3);
  });

  it('rejects a Variant that behaves like another option', async () => {
    // Swapping the arguments of the tie-breaker does the same as option 2's Variant.
    const result = await verify(candidate(withOption(3, { variant: { original: 'job.at < best.at', changed: 'best.at < job.at' } })), TYPESCRIPT, sandbox, { cacheRoot });
    assert.equal(result.verified, false);
    assert.match(result.verified ? '' : result.failures.map((f) => f.message).join('\n'), /Against option 4's Variant, only option 4's test may pass.*option 2's test passes too/);
  });

  it("rejects a 'wrong' option that is what the source does", async () => {
    const source = TS_REFERENCE.replace('job.at < best.at', 'job.at > best.at');
    const result = await verify(candidate(goodPrediction(), { source, lineComment: '//' }), TYPESCRIPT, sandbox, { cacheRoot });
    assert.equal(result.verified, false);
    assert.deepEqual(result.verified ? [] : result.failures.map((f) => f.check), ['real-variant']);
    assert.match(result.verified ? '' : result.failures[0]!.message, /Option 2's code is what the source does/);
  });
});
