import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffLines } from '../src/verify/diff.ts';

const lines = (...l: string[]) => l.join('\n') + '\n';

describe('diffLines', () => {
  it('finds no differences in identical text', () => {
    assert.deepEqual(diffLines(lines('a', 'b'), lines('a', 'b')), []);
  });

  it('ignores line endings, trailing whitespace, and trailing blank lines', () => {
    assert.deepEqual(diffLines('a\nb\n', 'a  \r\nb\r\n\n\n'), []);
  });

  it('reports a changed line with its position', () => {
    assert.deepEqual(diffLines(lines('a', 'b', 'c'), lines('a', 'B', 'c')), [{ line: 2, removed: ['b'], added: ['B'] }]);
  });

  it('reports separate regions as separate hunks', () => {
    const hunks = diffLines(lines('a', 'b', 'c', 'd', 'e'), lines('A', 'b', 'c', 'd', 'E'));
    assert.deepEqual(hunks.map((h) => h.line), [1, 5]);
  });

  it('reports pure insertions and deletions', () => {
    assert.deepEqual(diffLines(lines('a', 'c'), lines('a', 'b', 'c')), [{ line: 2, removed: [], added: ['b'] }]);
    assert.deepEqual(diffLines(lines('a', 'b', 'c'), lines('a', 'c')), [{ line: 2, removed: ['b'], added: [] }]);
  });

  it('keeps a multi-line replacement in one hunk', () => {
    const before = lines('fn x() {', '  let a = 1;', '  let b = 2;', '  return a + b;', '}');
    const after = lines('fn x() {', '  // TODO', '}');
    assert.deepEqual(diffLines(before, after), [
      { line: 2, removed: ['  let a = 1;', '  let b = 2;', '  return a + b;'], added: ['  // TODO'] },
    ]);
  });
});
