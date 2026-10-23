import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseGoJson, parseJunitXml, parseTap, parseUnittestVerbose } from '../src/languages/parsers.ts';

// Captured from real runs of node 22, Python 3.12, and Go 1.22.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('parseTap (node --test)', () => {
  it('reports leaf tests by path, telling assertion failures from errors', () => {
    assert.deepEqual(parseTap(fixture('node-mixed.tap')), [
      { name: 'add > adds', outcome: 'pass' },
      { name: 'add > wrong', outcome: 'assertion-failure' },
      { name: 'add > throws', outcome: 'error' },
      { name: 'top level', outcome: 'pass' },
    ]);
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
    assert.deepEqual(parseUnittestVerbose(fixture('unittest-mixed.txt')), [
      { name: 'AddTest.test_adds', outcome: 'pass' },
      { name: 'AddTest.test_sub', outcome: 'assertion-failure' },
      { name: 'AddTest.test_throws', outcome: 'error' },
      { name: 'AddTest.test_wrong', outcome: 'assertion-failure' },
      { name: 'Other.test_adds', outcome: 'pass' },
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
    assert.deepEqual(parseGoJson(fixture('go-mixed.jsonl')), [
      { name: 'TestAdds', outcome: 'pass' },
      { name: 'TestWrong', outcome: 'assertion-failure' },
      { name: 'TestTable/one', outcome: 'pass' },
      { name: 'TestTable/two', outcome: 'assertion-failure' },
    ]);
  });

  it('reports a panic as an error', () => {
    assert.deepEqual(parseGoJson(fixture('go-panic.jsonl')), [
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
    assert.deepEqual(parseJunitXml(xml), [
      { name: 'calc.AddTest.adds', outcome: 'pass' },
      { name: 'calc.AddTest.handles <0>', outcome: 'assertion-failure' },
      { name: 'throws', outcome: 'error' },
    ]);
  });

  it('treats a report without test cases as not run', () => {
    assert.equal(parseJunitXml('<testsuites/>'), undefined);
  });
});
