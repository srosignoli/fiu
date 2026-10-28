import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BackgroundCommand, describeDuration, describeResult, reportResult, runInForeground } from '../src/runner/background.ts';
import { tempDir } from './helpers.ts';

const start = async (command: string) => {
  const dir = await tempDir();
  return BackgroundCommand.start(command, { cwd: dir, logFile: join(dir, 'while', 'last.log'), shell: '/bin/sh' });
};

describe('background commands (kin quick --while)', () => {
  it('runs through the shell in the given directory, logging stdout and stderr, stdin closed', async () => {
    const command = await start('pwd; echo out && echo err >&2; cat; echo "stdin closed"');
    const result = await command.done;
    assert.equal(result.exitCode, 0);
    const log = await readFile(command.logFile, 'utf8');
    assert.match(log, /\/[^\n]+\nout\n/);
    assert.match(log, /err\n/);
    assert.match(log, /stdin closed\n/, 'cat reads /dev/null and ends at once');
    assert.equal(command.elapsedMs(), result.durationMs);
  });

  it('reports a failure with its exit code and the end of the log', async () => {
    const command = await start('for i in $(seq 1 30); do echo line $i; done; exit 3');
    const result = await command.done;
    assert.equal(result.exitCode, 3);
    const report = await reportResult(command, result);
    assert.match(report, /^✗ `for i in .*` failed \(exit 3\) after \d+s\n/);
    assert.match(report, / {2}│ line 30$/m);
    assert.doesNotMatch(report, /line 10$/m, 'only the last 20 lines');
    assert.match(report, new RegExp(`Log: ${command.logFile}$`));
  });

  it('stops the whole process group, escalating to SIGKILL', async () => {
    const polite = await start('sleep 30 & wait');
    const stopped = await polite.stop(5000);
    assert.equal(stopped.signal, 'SIGINT');
    assert.equal(stopped.exitCode, 130);
    assert.ok(stopped.durationMs < 5000);

    const stubborn = await start("trap '' INT; echo ready; sleep 30");
    while (!(await stubborn.tail(1)).includes('ready')) await new Promise((r) => setTimeout(r, 10));
    const killed = await stubborn.stop(200);
    assert.deepEqual([killed.signal, killed.exitCode], ['SIGKILL', 137]);
  });

  it('runs in the foreground when there is nothing to serve, returning the exit code', async () => {
    assert.equal(await runInForeground('exit 4', { cwd: await tempDir(), shell: '/bin/sh' }), 4);
  });

  it('describes durations and outcomes', () => {
    assert.deepEqual([describeDuration(4_400), describeDuration(182_000)], ['4s', '3m02s']);
    assert.equal(describeResult('npm test', { exitCode: 0, durationMs: 182_000 }), '✓ `npm test` finished in 3m02s');
    assert.equal(describeResult('npm test', { exitCode: 1, durationMs: 41_000 }), '✗ `npm test` failed (exit 1) after 41s');
  });
});
