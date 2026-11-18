import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAiAuthored, readCommit } from './kata.ts';

const message = (...lines: string[]) => lines.join('\n');

describe('screening a commit for AI co-authors', () => {
  it('marks a Claude co-authored commit as AI-written', () => {
    const body = message('Fix the queue cap', '', 'Track steps no longer count toward it.', '', 'Co-Authored-By: Claude Opus <noreply@anthropic.com>');
    assert.equal(isAiAuthored(body), true);
  });

  it('marks a message that is only an assistant trailer as AI-written', () => {
    assert.equal(isAiAuthored('Co-authored-by: GitHub Copilot <copilot@github.com>'), true);
  });

  it('does not mark a commit co-authored by a person', () => {
    const body = message('Pair on the lock', '', 'Co-Authored-By: Jane Doe <jane@example.com>');
    assert.equal(isAiAuthored(body), false);
  });

  it('does not mark a commit that only mentions an assistant in its text', () => {
    const body = message('Ask Claude to review the cache', '', 'Notes from the session with Copilot.');
    assert.equal(isAiAuthored(body), false);
  });

  it('reads the commit fields, AI authorship included', () => {
    const output = ['abc123', 'p1 p2', 'dev@example.com', 'Merge queue fixes', message('Merge queue fixes', '', 'Co-Authored-By: Claude <noreply@anthropic.com>')].join('\0');
    assert.deepEqual(readCommit(() => output, 'HEAD'), {
      sha: 'abc123',
      subject: 'Merge queue fixes',
      authorEmail: 'dev@example.com',
      parents: ['p1', 'p2'],
      aiAuthored: true,
    });
  });
});
