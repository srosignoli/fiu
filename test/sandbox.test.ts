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
    assert.deepEqual(result, { exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
  });

  it('kills the whole process group on timeout', async () => {
    const started = Date.now();
    const result = await runProcess('sleep 30 & sleep 30', { cwd: await tempDir(), env: { PATH: process.env.PATH! }, timeoutMs: 300 });
    assert.equal(result.stopped, 'timeout');
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

  it("gives commands the run's own writable TMPDIR", async () => {
    const result = await osSandbox!.run({ command: 'echo "$TMPDIR" && touch "$TMPDIR/probe"', cwd: await tempDir() });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /kintsugi-run-.*\/tmp$/m);
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

describe('resource limits', () => {
  const node = JSON.stringify(process.execPath);
  const env = { PATH: process.env.PATH! };
  const hog = (mib: number) =>
    `${node} -e "const a = []; for (let i = 0; i < ${mib / 10}; i++) a.push(Buffer.alloc(10 * 1024 * 1024, 1)); setTimeout(() => {}, 5000)"`;

  it('stop a process tree whose total memory exceeds the limit', async () => {
    const started = Date.now();
    const result = await runProcess(`for i in 1 2 3; do ${hog(150)} & done; wait`, {
      cwd: await tempDir(),
      env,
      timeoutMs: 8000,
      limits: { processMemoryMiB: 512, memoryMiB: 300, processes: 64 },
    });
    assert.equal(result.stopped, 'memory');
    assert.ok(Date.now() - started < 4000);
  });

  it('stop a process tree that starts too many processes', async () => {
    const result = await runProcess('for i in $(seq 60); do sleep 5 & done; wait', {
      cwd: await tempDir(),
      env,
      timeoutMs: 8000,
      limits: { processMemoryMiB: 512, memoryMiB: 2048, processes: 20 },
    });
    assert.equal(result.stopped, 'processes');
  });

  it('cap each process with the kernel, and the command cannot lift the caps', async () => {
    const result = await runProcess(`${hog(300)}; echo "exit=$?"; ulimit -d unlimited 2>/dev/null || echo cannot-raise`, {
      cwd: await tempDir(),
      env,
      timeoutMs: 8000,
      limits: { processMemoryMiB: 128, memoryMiB: 2048, processes: 64 },
    });
    assert.equal(result.stopped, undefined);
    assert.doesNotMatch(result.stdout, /exit=0/, 'the hog must fail under a 128 MiB per-process cap');
    assert.match(result.stdout, /cannot-raise/);
  });

  it('leave ordinary commands alone', async () => {
    const result = await runProcess(`${node} -e "console.log(Buffer.alloc(50 * 1024 * 1024).length)"`, { cwd: await tempDir(), env, timeoutMs: 8000 });
    assert.deepEqual({ ...result, stderr: '' }, { exitCode: 0, stdout: '52428800\n', stderr: '' });
  });
});
