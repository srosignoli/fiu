import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { AutoConsentRequiredError, autoStatus, enableAuto, hookInstalled, installHook, removeHook, setAuto } from '../src/background/auto.ts';
import { loadRepoConfig } from '../src/config.ts';
import { ensureWorkspace, workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';

const KIN = ['/usr/bin/node', '/opt/kin/dist/cli.js'];
const hookFile = (repo: string) => join(repo, '.git', 'hooks', 'post-commit');

describe('the post-commit hook', () => {
  it('is created executable, with a marked block that starts kin refill in the background', async () => {
    const repo = await tempGitRepo();
    const result = await installHook(repo, KIN);
    assert.deepEqual(result, { status: 'installed', path: hookFile(repo), created: true });
    const hook = await readFile(hookFile(repo), 'utf8');
    assert.match(hook, /^#!\/bin\/sh\n/);
    assert.match(hook, /# >>> kintsugi >>>[\s\S]*nohup '\/usr\/bin\/node' '\/opt\/kin\/dist\/cli\.js' 'refill' '--background' '--commit' "\$\(git rev-parse HEAD\)"[\s\S]*# <<< kintsugi <<</);
    assert.ok(statSync(hookFile(repo)).mode & 0o100, 'executable');
    assert.equal(await hookInstalled(repo), true);

    await removeHook(repo);
    assert.ok(!existsSync(hookFile(repo)), 'a hook Kintsugi created goes away entirely');
  });

  it("keeps the user's own hook lines, adding and removing only its block", async () => {
    const repo = await tempGitRepo();
    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
    const mine = '#!/bin/sh\necho "my own post-commit"\n';
    await writeFile(hookFile(repo), mine, { mode: 0o755 });

    await installHook(repo, KIN);
    await installHook(repo, KIN);
    const hook = await readFile(hookFile(repo), 'utf8');
    assert.ok(hook.startsWith(mine));
    assert.equal(hook.match(/# >>> kintsugi >>>/g)?.length, 1, 'reinstalling refreshes the block');

    assert.deepEqual(await removeHook(repo), { removed: true, path: hookFile(repo) });
    assert.equal(await readFile(hookFile(repo), 'utf8'), mine);
  });

  it('is left to the user when core.hooksPath manages hooks', async () => {
    const repo = await tempGitRepo();
    await execa('git', ['config', 'core.hooksPath', '.husky'], { cwd: repo });
    const result = await installHook(repo, KIN);
    assert.equal(result.status, 'manual');
    assert.match(result.status === 'manual' ? result.snippet : '', /refill' '--background'/);
    assert.ok(!existsSync(join(repo, '.husky')) && !existsSync(hookFile(repo)));
  });

  it('runs on a real commit without making it wait, with git’s commit-time variables cleared', async () => {
    const repo = await tempGitRepo();
    const marker = join(await tempDir(), 'ran.txt');
    const fakeKin = join(await tempDir(), 'fake-kin.sh');
    // Stands in for kin: records its arguments and the index variable, slowly.
    await writeFile(fakeKin, `sleep 2\necho "$@ index=[$GIT_INDEX_FILE]" > '${marker}'\n`);
    await installHook(repo, ['/bin/sh', fakeKin]);

    await writeFile(join(repo, 'a.txt'), 'a');
    await execa('git', ['add', '.'], { cwd: repo });
    const started = Date.now();
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one'], { cwd: repo });
    assert.ok(Date.now() - started < 1500, 'the commit returns before the background work finishes');
    const sha = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout;

    for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await readFile(marker, 'utf8')).trim(), `refill --background --commit ${sha} index=[]`);
  });
});

describe('kin auto on / off / status', () => {
  async function workspace() {
    const repo = await tempGitRepo();
    const paths = workspacePaths(repo);
    await ensureWorkspace(paths);
    return { repo, paths };
  }
  const base = { provider: 'anthropic' as const, model: 'claude-opus-5-5', kinCommand: KIN };

  it('needs explicit consent', async () => {
    const { paths } = await workspace();
    await assert.rejects(enableAuto({ ...base, paths, repoConfig: {}, yes: false }), AutoConsentRequiredError);
    const asked: string[] = [];
    const declined = await enableAuto({ ...base, paths, repoConfig: {}, yes: false, confirm: async (m) => (asked.push(m), false) });
    assert.equal(declined, undefined);
    assert.match(asked[0]!, /send the most-changed source file to anthropic \(claude-opus-5-5\)/);
    assert.match(asked[0]!, /at most 3 Workouts waiting in the queue, and at most 5 generations a day/);
    assert.equal((await loadRepoConfig(paths.configFile)).auto, undefined);
    assert.ok(!existsSync(hookFile(paths.repoRoot)));
  });

  it('records the consent and caps, installs the hook, and off keeps the caps', async () => {
    const { paths } = await workspace();
    const result = await enableAuto({ ...base, paths, repoConfig: {}, yes: false, caps: { dailyLimit: 2, aiOnly: true }, confirm: async () => true });
    assert.equal(result?.status, 'installed');
    const on = await loadRepoConfig(paths.configFile);
    assert.deepEqual({ ...on.auto, consentedAt: undefined }, { enabled: true, dailyLimit: 2, aiOnly: true, consentedAt: undefined });
    assert.equal(on.consent?.provider, 'anthropic', 'the question covers sending code, so it counts as consent');

    await setAuto(paths.configFile, false);
    assert.deepEqual((await loadRepoConfig(paths.configFile)).auto?.dailyLimit, 2);
    const status = await autoStatus(paths, await loadRepoConfig(paths.configFile));
    assert.deepEqual(
      { enabled: status.enabled, hook: status.hookInstalled, caps: status.caps, today: status.generationsToday, queued: status.queued },
      { enabled: false, hook: true, caps: { queueCap: 3, dailyLimit: 2, aiOnly: true, expiryDays: 14 }, today: 0, queued: 0 },
    );
  });
});
