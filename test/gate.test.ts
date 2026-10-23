import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { GO, PYTHON, TYPESCRIPT } from '../src/languages/builtin.ts';
import type { TestRun } from '../src/languages/profile.ts';
import { preflight } from '../src/languages/run.ts';
import { openSandbox } from '../src/sandbox/sandbox.ts';
import {
  checkMinimalDiff,
  checkReferencePasses,
  checkRegressionTest,
  checkStartingCodeFails,
  describeFailures,
  verify,
  type Candidate,
} from '../src/verify/gate.ts';
import { tempDir } from './helpers.ts';

const run = (...tests: [string, TestRun['tests'][number]['outcome']][]): TestRun => ({
  ran: true,
  tests: tests.map(([name, outcome]) => ({ name, outcome })),
  output: 'runner output',
});
const notRun: TestRun = { ran: false, tests: [], output: 'SyntaxError: nope' };
const checks = (failures: { check: string }[]) => failures.map((f) => f.check);

describe('checkReferencePasses', () => {
  it('requires every test to pass', () => {
    assert.deepEqual(checkReferencePasses(run(['a', 'pass'], ['b', 'pass'])), []);
    assert.match(checkReferencePasses(run(['a', 'pass'], ['b', 'error']))[0]!.message, /"b" \(error\)/);
    assert.deepEqual(checks(checkReferencePasses(notRun)), ['reference-passes']);
  });
});

describe('checkStartingCodeFails', () => {
  it('accepts code that runs, fails by assertion, and passes something', () => {
    assert.deepEqual(checkStartingCodeFails(run(['a', 'pass'], ['b', 'assertion-failure'])), []);
  });

  it('rejects code that does not run', () => {
    assert.equal(checkStartingCodeFails(notRun)[0]!.output, 'SyntaxError: nope');
  });

  it('rejects code that passes everything, fails everything, or crashes', () => {
    assert.match(checkStartingCodeFails(run(['a', 'pass']))[0]!.message, /no test fails by assertion/);
    assert.match(checkStartingCodeFails(run(['a', 'assertion-failure']))[0]!.message, /no test passes/);
    assert.match(
      checkStartingCodeFails(run(['a', 'pass'], ['b', 'assertion-failure'], ['c', 'error']))[0]!.message,
      /crash instead of failing by assertion: "c"/,
    );
  });
});

describe('checkRegressionTest', () => {
  const starting = run(['queue > keeps order', 'pass'], ['queue > starves late jobs', 'assertion-failure'], ['other', 'pass']);

  it('matches the full name or its last segments', () => {
    assert.deepEqual(checkRegressionTest('queue > starves late jobs', starting), []);
    assert.deepEqual(checkRegressionTest('starves late jobs', starting), []);
    assert.deepEqual(checkRegressionTest('test_x', run(['T.test_x', 'assertion-failure'])), []);
    assert.deepEqual(checkRegressionTest('two', run(['TestTable/two', 'assertion-failure'])), []);
  });

  it('requires a name that matches exactly one test', () => {
    assert.match(checkRegressionTest(undefined, starting)[0]!.message, /must name its Regression Test/);
    assert.match(checkRegressionTest('missing', starting)[0]!.message, /The tests are: queue > keeps order/);
    const twice = run(['a > same', 'assertion-failure'], ['b > same', 'assertion-failure']);
    assert.match(checkRegressionTest('same', twice)[0]!.message, /matches several tests/);
  });

  it('requires the Regression Test to fail by assertion', () => {
    assert.match(checkRegressionTest('keeps order', starting)[0]!.message, /but it passes/);
    assert.match(checkRegressionTest('a', run(['a', 'error'], ['b', 'pass']))[0]!.message, /but it crashes/);
  });
});

describe('checkMinimalDiff', () => {
  const reference = ['function f(xs) {', '  let total = 0;', '  for (const x of xs) total += x;', '  return total;', '}', ''].join('\n');
  const candidate = (startingCode: string, extra: Partial<Candidate> = {}): Candidate => ({
    kind: 'drill',
    startingCode,
    referenceSolution: reference,
    testSuiteCode: '',
    ...extra,
  });

  it('accepts a Drill whose bug is one small region', () => {
    assert.deepEqual(checkMinimalDiff(candidate(reference.replace('total = 0', 'total = 1'))), []);
  });

  it('rejects a Drill with no bug, several regions, or a large rewrite', () => {
    assert.match(checkMinimalDiff(candidate(reference))[0]!.message, /identical/);
    const twoPlaces = reference.replace('total = 0', 'total = 1').replace('return total', 'return -total');
    assert.match(checkMinimalDiff(candidate(twoPlaces))[0]!.message, /2 places \(line 2, line 4\)/);
    const rewrite = ['function f(xs) {', '  return xs.reduce((a, b) => a - b, 1)', '    + 0', '    + 0', '    + 0;', '}'].join('\n');
    assert.match(checkMinimalDiff(candidate(rewrite))[0]!.message, /changes 4 lines/);
  });

  it('checks a Kata gap and, for a Quick Kata, its size', () => {
    const gapped = ['function f(xs) {', '  // TODO', '}', ''].join('\n');
    assert.deepEqual(checkMinimalDiff(candidate(gapped, { kind: 'kata' })), []);
    assert.match(checkMinimalDiff(candidate(gapped, { kind: 'kata', quick: true }))[0]!.message, /removes 3 lines; a Quick Kata removes 5 to 12/);
    const padded = ['function f(xs) {', '  // a', '  // b', '  // c', '  // d', '}'].join('\n');
    assert.match(checkMinimalDiff(candidate(padded, { kind: 'kata' }))[0]!.message, /4 placeholder lines/);
  });
});

describe('describeFailures', () => {
  it('lists each failed check with its output, keeping the end of long output', () => {
    const text = describeFailures(
      [
        { check: 'minimal-diff', message: 'Too big.' },
        { check: 'reference-passes', message: 'Fails.', output: `start${'x'.repeat(50)}end` },
      ],
      10,
    );
    assert.equal(text, '[minimal-diff] Too big.\n\n[reference-passes] Fails.\nTest output:\n…xxxxxxxend');
  });
});

// The whole gate on real Drills, through the sandbox (or without one where it isn't installed).
const sandbox = await openSandbox({ allowUnsandboxed: true });
after(() => sandbox.dispose());

const TS_TESTS = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickNext } from './kata.ts';

describe('pickNext', () => {
  it('picks the highest priority', () => assert.equal(pickNext([{ id: 'a', priority: 1, at: 0 }, { id: 'b', priority: 5, at: 1 }]), 'b'));
  it('returns undefined when empty', () => assert.equal(pickNext([]), undefined));
  it('serves equal priorities first come, first served', () =>
    assert.equal(pickNext([{ id: 'early', priority: 3, at: 1 }, { id: 'late', priority: 3, at: 2 }]), 'early'));
});
`;

const TS_REFERENCE = `export interface Job { id: string; priority: number; at: number }

export function pickNext(jobs: Job[]): string | undefined {
  let best: Job | undefined;
  for (const job of jobs) {
    if (!best || job.priority > best.priority || (job.priority === best.priority && job.at < best.at)) best = job;
  }
  return best?.id;
}
`;

const tsDrill = (startingCode: string, extra: Partial<Candidate> = {}): Candidate => ({
  kind: 'drill',
  startingCode,
  referenceSolution: TS_REFERENCE,
  testSuiteCode: TS_TESTS,
  regressionTestName: 'serves equal priorities first come, first served',
  ...extra,
});

describe(`verify (${sandbox.isolated ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  it('verifies a well-formed TypeScript Drill', async () => {
    const result = await verify(tsDrill(TS_REFERENCE.replace('job.at < best.at', 'job.at > best.at')), TYPESCRIPT, sandbox, {
      cacheRoot: await tempDir(),
    });
    assert.ok(result.verified, result.verified ? '' : describeFailures(result.failures));
    assert.equal(result.startingRun.tests.find((t) => t.name.endsWith('first served'))?.outcome, 'assertion-failure');
  });

  it('rejects a Drill whose "bug" changes nothing observable', async () => {
    // A small, single-line change, so only the test-based checks catch it.
    const result = await verify(tsDrill(TS_REFERENCE.replace('let best', 'let best ')), TYPESCRIPT, sandbox);
    assert.equal(result.verified, false);
    assert.deepEqual(checks(!result.verified ? result.failures : []), ['starting-code-fails', 'regression-test']);
  });

  it('rejects a Drill whose Reference Solution fails its own tests', async () => {
    const broken = TS_REFERENCE.replace('job.at < best.at', 'job.at > best.at');
    const result = await verify(tsDrill(broken, { referenceSolution: broken }), TYPESCRIPT, sandbox);
    assert.equal(result.verified, false);
    assert.ok(checks(!result.verified ? result.failures : []).includes('reference-passes'));
  });

  it('rejects a Drill whose bug crashes instead of failing an assertion', async () => {
    const crashing = TS_REFERENCE.replace('return best?.id;', 'return (best as any).nope.id;');
    const result = await verify(tsDrill(crashing), TYPESCRIPT, sandbox);
    assert.equal(result.verified, false);
    const text = describeFailures(!result.verified ? result.failures : []);
    assert.match(text, /crash instead of failing by assertion/);
    assert.match(text, /Test output:/);
  });

  it('verifies a Python Drill', async () => {
    const reference = 'def window(xs, size):\n    return [xs[i:i + size] for i in range(len(xs) - size + 1)]\n';
    const tests = `import unittest
from kata import window

class WindowTest(unittest.TestCase):
    def test_empty_when_too_short(self):
        self.assertEqual(window([1], 2), [])

    def test_includes_the_last_window(self):
        self.assertEqual(window([1, 2, 3], 2), [[1, 2], [2, 3]])
`;
    const result = await verify(
      {
        kind: 'drill',
        referenceSolution: reference,
        startingCode: reference.replace('len(xs) - size + 1', 'len(xs) - size'),
        testSuiteCode: tests,
        regressionTestName: 'test_includes_the_last_window',
      },
      PYTHON,
      sandbox,
    );
    assert.ok(result.verified, result.verified ? '' : describeFailures(result.failures));
  });

  it('verifies a Go Drill', async () => {
    // As in real use, the preflight warms Go's build cache before the gate runs.
    const cacheRoot = await tempDir();
    await preflight(sandbox, GO, cacheRoot);
    const reference = 'package kata\n\nfunc Sum(xs []int) int {\n\ttotal := 0\n\tfor _, x := range xs {\n\t\ttotal += x\n\t}\n\treturn total\n}\n';
    const tests = `package kata

import "testing"

func TestEmpty(t *testing.T) {
	if got := Sum(nil); got != 0 {
		t.Errorf("Sum(nil) = %d", got)
	}
}

func TestCountsEveryElement(t *testing.T) {
	if got := Sum([]int{1, 2, 3}); got != 6 {
		t.Errorf("Sum = %d, want 6", got)
	}
}
`;
    const result = await verify(
      {
        kind: 'drill',
        referenceSolution: reference,
        startingCode: reference.replace('for _, x := range xs {', 'for _, x := range xs[1:] {'),
        testSuiteCode: tests,
        regressionTestName: 'TestCountsEveryElement',
      },
      GO,
      sandbox,
      { cacheRoot },
    );
    // xs[1:] on nil panics: TestEmpty crashes, so this Drill must be rejected.
    assert.equal(result.verified, false);
    assert.match(describeFailures(!result.verified ? result.failures : []), /"TestEmpty" \(error\)/);
  });
});
