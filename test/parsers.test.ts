import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseGoJson, parseJunitXml, parseTap, parseUnittestVerbose, trimPythonTraceback } from '../src/languages/parsers.ts';
import type { TestResult } from '../src/languages/profile.ts';

// Captured from real runs of node 22, Python 3.12, and Go 1.22.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const outcomes = (tests: TestResult[] | undefined) => tests?.map(({ name, outcome }) => ({ name, outcome }));
const messageOf = (tests: TestResult[] | undefined, name: string) => tests?.find((t) => t.name === name)?.message;

describe('parseTap (node --test)', () => {
  it('reports leaf tests by path, telling assertion failures from errors', () => {
    const tests = parseTap(fixture('node-mixed.tap'));
    assert.deepEqual(outcomes(tests), [
      { name: 'add > adds', outcome: 'pass' },
      { name: 'add > wrong', outcome: 'assertion-failure' },
      { name: 'add > throws', outcome: 'error' },
      { name: 'top level', outcome: 'pass' },
    ]);
    assert.equal(messageOf(tests, 'add > wrong'), 'Expected values to be strictly equal:\n\n3 !== 4');
    assert.equal(messageOf(tests, 'add > throws'), 'boom');
    assert.equal(messageOf(tests, 'add > adds'), undefined);
  });

  it('treats a file that fails to load as not run', () => {
    assert.equal(parseTap(fixture('node-broken.tap')), undefined);
  });

  it('leaves out skipped and todo tests', () => {
    const tap = ['TAP version 13', 'ok 1 - a # SKIP not now', 'ok 2 - b # TODO later', 'ok 3 - c', '1..3'].join('\n');
    assert.deepEqual(parseTap(tap), [{ name: 'c', outcome: 'pass' }]);
  });

  it('treats output with no tests as not run', () => {
    assert.equal(parseTap('TAP version 13\n1..0\n'), undefined);
  });
});

describe('parseUnittestVerbose', () => {
  it('names tests Class.method and takes outcomes from the final report', () => {
    // The fixture has a docstring, a failing subTest, and stderr noise mid-line.
    const tests = parseUnittestVerbose(fixture('unittest-mixed.txt'));
    assert.deepEqual(outcomes(tests), [
      { name: 'AddTest.test_adds', outcome: 'pass' },
      { name: 'AddTest.test_sub', outcome: 'assertion-failure' },
      { name: 'AddTest.test_throws', outcome: 'error' },
      { name: 'AddTest.test_wrong', outcome: 'assertion-failure' },
      { name: 'Other.test_adds', outcome: 'pass' },
    ]);
    assert.match(messageOf(tests, 'AddTest.test_wrong')!, /^Traceback[\s\S]*\nAssertionError: 3 != 4$/);
    assert.match(messageOf(tests, 'AddTest.test_throws')!, /TypeError: boom$/);
  });

  it("trims tracebacks to the Workout's own frames", () => {
    // An IsolatedAsyncioTestCase: four unittest and asyncio frames above the test's own.
    const message = messageOf(parseUnittestVerbose(fixture('unittest-async.txt')), 'ResolveTests.test_accept_reports_mission')!;
    assert.equal(
      message.split('\n').slice(0, 4).join('\n'),
      [
        'Traceback (most recent call last):',
        '  File "test_kata.py", line 12, in test_accept_reports_mission',
        '    self.assertEqual(resolve("abc", True), (True, "m1"))',
        "AssertionError: Tuples differ: (False, None) != (True, 'm1')",
      ].join('\n'),
    );
    assert.doesNotMatch(message, /asyncio|unittest|\^\^/);
  });

  it('keeps frames in the code under test, and the innermost frame when every frame is library code', () => {
    const traceback = [
      'Traceback (most recent call last):',
      '  File "/usr/lib/python3.12/unittest/case.py", line 58, in testPartExecutor',
      '    yield',
      '  File "/tmp/fiu-verify-x/test_kata.py", line 9, in test_x',
      '    pick([])',
      '  File "/tmp/fiu-verify-x/kata.py", line 4, in pick',
      '    return jobs[0]',
      '           ~~~~^^^',
      'IndexError: list index out of range',
    ];
    assert.deepEqual(trimPythonTraceback(traceback), [
      'Traceback (most recent call last):',
      '  File "test_kata.py", line 9, in test_x',
      '    pick([])',
      '  File "kata.py", line 4, in pick',
      '    return jobs[0]',
      'IndexError: list index out of range',
    ]);
    const libraryOnly = [
      'Traceback (most recent call last):',
      '  File "/usr/lib/python3.12/asyncio/runners.py", line 118, in run',
      '    return self._loop.run_until_complete(task)',
      '  File "/usr/lib/python3.12/asyncio/base_events.py", line 687, in run_until_complete',
      '    return future.result()',
      '           ^^^^^^^^^^^^^^^',
      'asyncio.exceptions.CancelledError',
    ];
    assert.deepEqual(trimPythonTraceback(libraryOnly), [
      'Traceback (most recent call last):',
      '  File "base_events.py", line 687, in run_until_complete',
      '    return future.result()',
      'asyncio.exceptions.CancelledError',
    ]);
  });

  it('treats an import or syntax error as not run', () => {
    assert.equal(parseUnittestVerbose(fixture('unittest-broken.txt')), undefined);
  });

  it('treats a test module that cannot be loaded as not run', () => {
    const stderr = [
      'test_kata (unittest.loader._FailedTest.test_kata) ... ERROR',
      '',
      'ERROR: test_kata (unittest.loader._FailedTest.test_kata)',
      'ImportError: Failed to import test module: test_kata',
      '',
      'Ran 1 test in 0.000s',
    ].join('\n');
    assert.equal(parseUnittestVerbose(stderr), undefined);
  });

  it('leaves out skipped tests', () => {
    const stderr = ['test_a (t.T.test_a) ... skipped \'later\'', 'test_b (t.T.test_b) ... ok', '', 'Ran 2 tests in 0.001s', 'OK (skipped=1)'].join('\n');
    assert.deepEqual(parseUnittestVerbose(stderr), [{ name: 'T.test_b', outcome: 'pass' }]);
  });
});

describe('parseGoJson', () => {
  it('reports leaf tests; t.Error failures are assertion failures', () => {
    const tests = parseGoJson(fixture('go-mixed.jsonl'));
    assert.deepEqual(outcomes(tests), [
      { name: 'TestAdds', outcome: 'pass' },
      { name: 'TestWrong', outcome: 'assertion-failure' },
      { name: 'TestTable/one', outcome: 'pass' },
      { name: 'TestTable/two', outcome: 'assertion-failure' },
    ]);
    assert.equal(messageOf(tests, 'TestWrong'), 'kata_test.go:6: Add(1,2) = 3, want 4');
  });

  it('reports a panic as an error', () => {
    const tests = parseGoJson(fixture('go-panic.jsonl'));
    assert.match(messageOf(tests, 'TestPanics')!, /^panic: assignment to entry in nil map/);
    assert.deepEqual(outcomes(tests), [
      { name: 'TestAdds', outcome: 'pass' },
      { name: 'TestPanics', outcome: 'error' },
    ]);
  });

  it('treats a build failure as not run', () => {
    assert.equal(parseGoJson(fixture('go-broken.jsonl')), undefined);
  });
});

describe('parseJunitXml', () => {
  it('maps failure, error, and skipped elements', () => {
    const xml = `<?xml version="1.0"?>
      <testsuites><testsuite name="s">
        <testcase classname="calc.AddTest" name="adds" time="0.1"/>
        <testcase classname="calc.AddTest" name="handles &lt;0&gt;"><failure message="3 != 4">trace</failure></testcase>
        <testcase name='throws'><error type="TypeError"/></testcase>
        <testcase name="later"><skipped/></testcase>
      </testsuite></testsuites>`;
    const tests = parseJunitXml(xml);
    assert.equal(messageOf(tests, 'calc.AddTest.handles <0>'), '3 != 4\ntrace');
    assert.deepEqual(outcomes(tests), [
      { name: 'calc.AddTest.adds', outcome: 'pass' },
      { name: 'calc.AddTest.handles <0>', outcome: 'assertion-failure' },
      { name: 'throws', outcome: 'error' },
    ]);
  });

  it('treats a report without test cases as not run', () => {
    assert.equal(parseJunitXml('<testsuites/>'), undefined);
  });
});
