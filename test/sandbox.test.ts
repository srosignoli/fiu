import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCanary, verifySandbox } from '../src/sandbox/canary.ts';
import { runProcess } from '../src/sandbox/process.ts';
import { openSandbox, openUnsandboxed, SandboxUnavailableError } from '../src/sandbox/sandbox.ts';
import { tempDir } from './helpers.ts';

describe('runProcess', () => {
  it('captures output and the exit code', async () => {
    const result = await runProcess('echo out; echo err >&2; exit 3', { cwd: await tempDir(), env: {}, timeoutMs: 5000 });
    assert.deepEqual(result, { exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  it('kills the whole process group on timeout', async () => {
    const started = Date.now();
    const result = await runProcess('sleep 30 & sleep 30', { cwd: await tempDir(), env: { PATH: process.env.PATH! }, timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 5000);
  });
});

describe('unsandboxed runs', () => {
  it('still scrub the environment and use a scratch HOME', async () => {
    process.env.KINTSUGI_TEST_SECRET = 'leak';
    try {
      const cwd = await tempDir();
      const result = await openUnsandboxed().run({
        command: 'env; pwd',
        cwd,
        env: { PROFILE_VAR: 'yes' },
      });
      assert.equal(result.exitCode, 0);
      assert.doesNotMatch(result.stdout, /KINTSUGI_TEST_SECRET/);
      assert.match(result.stdout, /^PROFILE_VAR=yes$/m);
      assert.match(result.stdout, /^HOME=.*kintsugi-run-.*\/home$/m);
      assert.match(result.stdout, new RegExp(`^${cwd}$`, 'm'));
    } finally {
      delete process.env.KINTSUGI_TEST_SECRET;
    }
  });

  it('fail the canary', async () => {
    const report = await runCanary(openUnsandboxed(), await tempDir());
    assert.equal(report.passed, false);
    assert.ok(report.failures.includes('Writing outside the Workout directory was not blocked.'));
    assert.ok(!report.failures.includes('Environment variables leaked into the sandbox.'));
  });

  it('skip verification, since the user opted out of isolation', async () => {
    await verifySandbox(openUnsandboxed(), { fresh: true, cacheDir: await tempDir() });
  });
});

// Runs only where the OS sandbox's dependencies are installed.
const osSandbox = await openSandbox().catch((error) => {
  if (error instanceof SandboxUnavailableError) return undefined;
  throw error;
});

describe('OS sandbox', { skip: osSandbox ? false : 'sandbox dependencies are not installed' }, () => {
  it('passes the canary and caches the pass', async () => {
    const cacheDir = await tempDir();
    await verifySandbox(osSandbox!, { fresh: true, cacheDir });
    const cached = JSON.parse(await readFile(join(cacheDir, 'sandbox-canary.json'), 'utf8'));
    assert.match(cached.key, new RegExp(process.version.replaceAll('.', '\\.')));
  });

  it('runs commands in the Workout directory', async () => {
    const cwd = await tempDir();
    const result = await osSandbox!.run({ command: 'echo hi > out.txt && cat out.txt', cwd });
    assert.equal(result.stdout, 'hi\n');
  });

  it('keeps the repository unreadable except for the Workout directory', async () => {
    const repoRoot = await tempDir();
    const sandbox = await openSandbox({ repoRoot });
    try {
      const workout = join(repoRoot, '.kintsugi', 'workouts', 'w1');
      await mkdir(workout, { recursive: true });
      await writeFile(join(repoRoot, '.env'), 'SECRET=1');
      const result = await sandbox.run({ command: `cat ${join(repoRoot, '.env')}; echo ok > here.txt && cat here.txt`, cwd: workout });
      assert.doesNotMatch(result.stdout, /SECRET/);
      assert.match(result.stdout, /^ok$/m);
    } finally {
      await sandbox.dispose();
    }
  });

  it('dispose', async () => {
    await osSandbox!.dispose();
  });
});

describe('openSandbox', () => {
  it('falls back to no isolation only when the user opts out', async () => {
    const sandbox = await openSandbox({ allowUnsandboxed: true });
    try {
      assert.equal(sandbox.isolated, osSandbox !== undefined);
    } finally {
      await sandbox.dispose();
    }
  });
});
