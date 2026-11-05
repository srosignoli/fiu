import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { tempDir, tempGitRepo } from './helpers.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = async (cwd: string, ...args: string[]) =>
  execa('node', ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', CLI, ...args], {
    cwd,
    reject: false,
    // Keep the sandbox canary's cache out of the real ~/.cache.
    env: { XDG_CACHE_HOME: await tempDir(), XDG_CONFIG_HOME: await tempDir() },
  });

describe('cli', () => {
  it('fiu init sets up the workspace', async () => {
    const repo = await tempGitRepo();
    const { exitCode, stdout, stderr } = await run(repo, 'init');
    assert.match(stdout, /Created .*\.fiutsu/);
    // Whether the sandbox works depends on the machine; either way the outcome is reported.
    if (exitCode === 0) assert.match(stdout, /Sandbox check passed/);
    else assert.match(stderr, /No working sandbox is available/);
    assert.match(stdout, /Tip: disable AI completions/);
    assert.ok(existsSync(join(repo, '.fiutsu', 'state.json')));
  });

  it('fails cleanly outside a git repository', async () => {
    const { exitCode, stderr } = await run(await tempDir(), 'init');
    assert.equal(exitCode, 1);
    assert.match(stderr, /^fiutsu: .* is not inside a git repository/);
  });
});
