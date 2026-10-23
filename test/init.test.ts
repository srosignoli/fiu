import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { init as runInit } from '../src/commands/init.ts';
import { ConfigError } from '../src/config.ts';
import { SandboxUnavailableError } from '../src/sandbox/sandbox.ts';
import { NotAGitRepositoryError } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';

// The real sandbox check has its own tests; here it always passes.
const init = (cwd: string) => runInit(cwd, { checkSandbox: async () => {} });
const readExclude = (repo: string) => readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');

describe('init', () => {
  it('creates the workspace with empty config and state', async () => {
    const repo = await tempGitRepo();
    const result = await init(repo);

    assert.equal(result.createdWorkspace, true);
    assert.deepEqual(JSON.parse(await readFile(join(repo, '.kintsugi', 'config.json'), 'utf8')), {});
    assert.deepEqual(JSON.parse(await readFile(join(repo, '.kintsugi', 'state.json'), 'utf8')), { outcomes: [] });
    assert.ok((await stat(join(repo, '.kintsugi', 'workouts'))).isDirectory());
    assert.ok((await stat(join(repo, '.kintsugi', 'done'))).isDirectory());
  });

  it('works from a subdirectory, placing the workspace at the repo root', async () => {
    const repo = await tempGitRepo();
    await mkdir(join(repo, 'src', 'deep'), { recursive: true });
    const result = await init(join(repo, 'src', 'deep'));
    assert.equal(result.paths.root, join(repo, '.kintsugi'));
  });

  it('hides the workspace from git without touching .gitignore', async () => {
    const repo = await tempGitRepo();
    await writeFile(join(repo, 'tracked.txt'), 'x');
    await init(repo);

    assert.match(await readExclude(repo), /^\/\.kintsugi\/$/m);
    const { stdout } = await execa('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo });
    assert.equal(stdout.trim(), '?? tracked.txt');
  });

  it('is idempotent and never overwrites existing files', async () => {
    const repo = await tempGitRepo();
    await init(repo);
    const config = join(repo, '.kintsugi', 'config.json');
    await writeFile(config, JSON.stringify({ model: 'my-model' }));

    const second = await init(repo);

    assert.equal(second.createdWorkspace, false);
    assert.equal(second.updatedGitExclude, false);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { model: 'my-model' });
    assert.equal((await readExclude(repo)).match(/kintsugi/g)?.length, 1);
  });

  it('appends to an exclude file that lacks a trailing newline', async () => {
    const repo = await tempGitRepo();
    await writeFile(join(repo, '.git', 'info', 'exclude'), '*.log');
    await init(repo);
    assert.equal(await readExclude(repo), '*.log\n/.kintsugi/\n');
  });

  it('rejects directories outside a git repository', async () => {
    await assert.rejects(init(await tempDir()), NotAGitRepositoryError);
  });

  it('reports an unavailable sandbox without failing the workspace setup', async () => {
    const repo = await tempGitRepo();
    let checkedRoot: string | undefined;
    const result = await runInit(repo, {
      checkSandbox: async (root) => {
        checkedRoot = root;
        throw new SandboxUnavailableError(['socat not installed']);
      },
    });
    assert.equal(checkedRoot, result.paths.repoRoot);
    assert.match(result.sandboxProblem?.message ?? '', /socat not installed/);
    assert.equal(result.createdWorkspace, true);
  });

  it('reports an invalid pre-existing config', async () => {
    const repo = await tempGitRepo();
    await mkdir(join(repo, '.kintsugi'));
    await writeFile(join(repo, '.kintsugi', 'config.json'), '{ nope');
    await assert.rejects(init(repo), ConfigError);
  });
});
