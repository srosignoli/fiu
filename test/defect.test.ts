import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkWorkoutOutput } from '../src/synthesis/schema.ts';
import { bugComments, findOriginalDefect, matchSource, normaliseLine } from '../src/verify/defect.ts';
import { goodDrill, goodKata, TS_REFERENCE } from './mock-model.ts';

// From dogfooding (2026-10-29): the source joins sorted tags with the wrong bound, and the Drill
// rewrote the code around that line but kept the comparison as its bug.
const ORIGINAL = `def NormalizeContext(array):
    adict = {}
    ordered = ""
    for part in array:
        adict[part] = 1
    akeys = list(adict.keys())
    akeys.sort()
    for index,part in enumerate(akeys):
        ordered += part
        if index < len(part)-1:
            ordered = ordered + ","
    return ordered
`;

const drillCode = (bound: string, comment = '') => `def NormalizeContext(array):
    unique = sorted(set(part.strip() for part in array if part.strip()))
    ordered = ""
    for index, part in enumerate(unique):
        ordered += part
        if index < ${bound} - 1:${comment}
            ordered += ","
    return ordered
`;

const normalizeContext = (comment = '') => ({ startingCode: drillCode('len(part)', comment), referenceSolution: drillCode('len(unique)') });

describe('normaliseLine', () => {
  it('drops the trailing comment and all whitespace', () => {
    assert.equal(normaliseLine('        if index < len(part) - 1:   # <-- here', '#'), 'ifindex<len(part)-1:');
    assert.equal(normaliseLine('if index < len(part)-1:'), 'ifindex<len(part)-1:');
    assert.equal(normaliseLine('x = 1 # kept without a marker'), 'x=1#keptwithoutamarker');
  });
});

describe('matchSource', () => {
  it('finds the dogfooded bug in its source, despite the rewrite around it', () => {
    assert.deepEqual(matchSource(normalizeContext(), ORIGINAL, '#'), { startLine: 10, endLine: 10 });
  });

  it('ignores a comment on the buggy line', () => {
    assert.deepEqual(matchSource(normalizeContext('   # <-- compares the wrong length'), ORIGINAL, '#'), { startLine: 10, endLine: 10 });
  });

  it("doesn't match when the source has the fixed line", () => {
    assert.equal(matchSource(normalizeContext(), ORIGINAL.replace('len(part)-1', 'len(akeys)-1'), '#'), undefined);
    const both = ORIGINAL.replace('    return ordered', '    if index < len(unique) - 1:\n        pass\n    return ordered');
    assert.equal(matchSource(normalizeContext(), both, '#'), undefined);
  });

  it('needs every significant buggy line in the source, and at least one', () => {
    assert.equal(matchSource(goodDrill(), TS_REFERENCE, '//'), undefined);
    assert.ok(matchSource(goodDrill(), goodDrill().startingCode, '//'));
    // Short lines alone are no evidence.
    assert.equal(matchSource({ referenceSolution: 'a\n  return x\nb\n', startingCode: 'a\n  return y\nb\n' }, 'return y\n'), undefined);
    // A bug that only removes lines has no buggy side.
    assert.equal(matchSource({ referenceSolution: 'a\n  await flush(queue)\nb\n', startingCode: 'a\nb\n' }, 'a\nb\n'), undefined);
  });
});

describe('findOriginalDefect', () => {
  const source = goodDrill().startingCode;
  const report = { startLine: 5, endLine: 5, description: 'Ties go to the latest job.' };

  it('combines the source match with the model report', () => {
    assert.deepEqual(findOriginalDefect('drill', goodDrill(), source, '//'), {
      startLine: 6,
      endLine: 6,
      description: 'The tie-breaker compares arrival times the wrong way round.',
      evidence: 'source',
    });
    assert.equal(findOriginalDefect('drill', goodDrill({ originalDefect: report }), source, '//')?.evidence, 'both');
    assert.deepEqual(findOriginalDefect('drill', goodDrill({ originalDefect: report }), TS_REFERENCE, '//'), { ...report, evidence: 'model' });
  });

  it('reports nothing when neither signal fires, and ignores an unusable model report', () => {
    assert.equal(findOriginalDefect('drill', goodDrill(), TS_REFERENCE, '//'), undefined);
    assert.equal(findOriginalDefect('drill', goodDrill({ originalDefect: { ...report, endLine: 999 } }), TS_REFERENCE, '//'), undefined);
    assert.equal(findOriginalDefect('drill', goodDrill({ originalDefect: { ...report, description: ' ' } }), TS_REFERENCE, '//'), undefined);
  });

  it('only takes the model report for a Kata', () => {
    assert.equal(findOriginalDefect('kata', goodKata(), goodKata().startingCode, '//'), undefined);
    assert.equal(findOriginalDefect('kata', goodKata({ originalDefect: report }), TS_REFERENCE, '//')?.evidence, 'model');
  });
});

describe('comments in the bug', () => {
  it('are found on the buggy lines only when the fixed lines lack them', () => {
    assert.deepEqual(bugComments(normalizeContext('   # <-- compares tag index against len(part)!'), '#'), ['# <-- compares tag index against len(part)!']);
    assert.deepEqual(bugComments(normalizeContext(), '#'), []);
    const same = { startingCode: drillCode('len(part)', '  # last one'), referenceSolution: drillCode('len(unique)', '  # last one') };
    assert.deepEqual(bugComments(same, '#'), []);
    assert.deepEqual(bugComments(normalizeContext('  # x'), undefined), []);
  });

  it('are retry feedback for a Drill', () => {
    const drill = goodDrill({ startingCode: goodDrill().startingCode.replace('best = job;\n', 'best = job; // newest wins\n') });
    const problems = checkWorkoutOutput('drill', drill, 10, { lineComment: '//' });
    assert.match(problems.join(), /the bug region carries a comment that points at the bug \("\/\/ newest wins"\)/);
  });
});
