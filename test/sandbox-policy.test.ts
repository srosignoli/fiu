import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filesystemPolicy, scrubbedEnv } from '../src/sandbox/policy.ts';

describe('filesystemPolicy', () => {
  it('denies secrets and the repository, and allows only the listed writable paths', () => {
    const policy = filesystemPolicy(
      { writable: ['/repo/.fiu/workouts/w1', '/cache/go'], denyRead: ['/extra'] },
      { home: '/home/u', repoRoot: '/repo' },
    );
    assert.deepEqual(policy.denyRead, [
      '/home/u/.ssh',
      '/home/u/.aws',
      '/home/u/.config',
      '/home/u/.gnupg',
      '/home/u/.netrc',
      '/repo',
      '/extra',
    ]);
    assert.deepEqual(policy.allowWrite, ['/repo/.fiu/workouts/w1', '/cache/go']);
    // Re-allows the Workout directory inside the otherwise-denied repo.
    assert.deepEqual(policy.allowRead, policy.allowWrite);
  });

  it('leaves the repository readable when none is given', () => {
    const policy = filesystemPolicy({ writable: ['/w'] }, { home: '/home/u' });
    assert.equal(policy.denyRead.length, 5);
  });
});

describe('scrubbedEnv', () => {
  const base = { PATH: '/bin', LANG: 'en_GB.UTF-8', ANTHROPIC_API_KEY: 'sk', GITHUB_TOKEN: 'gh', HOME: '/home/u' };

  it('keeps only the allowlist, with a scratch HOME and TMPDIR', () => {
    assert.deepEqual(scrubbedEnv({ home: '/s/home', tmp: '/s/tmp', base }), {
      PATH: '/bin',
      LANG: 'en_GB.UTF-8',
      HOME: '/s/home',
      TMPDIR: '/s/tmp',
    });
  });

  it('adds the profile variables', () => {
    const env = scrubbedEnv({ home: '/h', tmp: '/t', base, extra: { GOPROXY: 'off' } });
    assert.equal(env.GOPROXY, 'off');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });
});
