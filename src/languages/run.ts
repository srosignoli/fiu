import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userCacheDir } from '../config.ts';
import { DEFAULT_TIMEOUT_MS } from '../sandbox/policy.ts';
import { DEFAULT_LIMITS, describeStop } from '../sandbox/process.ts';
import type { RunRequest, Sandbox } from '../sandbox/sandbox.ts';
import { PARSERS } from './parsers.ts';
import type { LanguageProfile, TestRun } from './profile.ts';

export class ToolchainMissingError extends Error {
  constructor(profile: LanguageProfile, output: string) {
    super(`The ${profile.id} toolchain is not available (\`${profile.preflightCmd}\` failed):\n${output.trim()}`);
  }
}

/** Runs the profile's cheap toolchain check inside the sandbox; throws ToolchainMissingError if it fails. */
export async function preflight(sandbox: Sandbox, profile: LanguageProfile, cacheRoot = userCacheDir()): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'kintsugi-preflight-'));
  try {
    const result = await sandbox.run({ ...(await runRequest(profile, cwd, cacheRoot)), command: profile.preflightCmd });
    if (result.exitCode !== 0) throw new ToolchainMissingError(profile, result.stderr || result.stdout);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Runs a Workout's tests once, in the sandbox, and normalises the results. */
export async function runTests(
  sandbox: Sandbox,
  profile: LanguageProfile,
  workoutDir: string,
  cacheRoot = userCacheDir(),
): Promise<TestRun> {
  const resultPath = profile.resultFile && join(workoutDir, profile.resultFile);
  if (resultPath) await rm(resultPath, { force: true });

  const result = await sandbox.run(await runRequest(profile, workoutDir, cacheRoot));
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  if (result.stopped) {
    const message = describeStop(result.stopped, { ...DEFAULT_LIMITS, ...profile.limits }, DEFAULT_TIMEOUT_MS);
    return { ran: false, stopped: result.stopped, tests: [], output: `${output}\n${message}`.trim() };
  }

  const resultFile = resultPath ? await readFile(resultPath, 'utf8').catch(() => undefined) : undefined;
  if (resultPath && resultFile === undefined) return { ran: false, tests: [], output };
  const tests = PARSERS[profile.resultFormat]({ stdout: result.stdout, stderr: result.stderr, resultFile });
  return { ran: tests !== undefined, tests: tests ?? [], output };
}

async function runRequest(profile: LanguageProfile, cwd: string, cacheRoot: string): Promise<RunRequest> {
  const cacheEnv: Record<string, string> = {};
  for (const variable of profile.cacheDirs) {
    const dir = join(cacheRoot, profile.id, variable);
    await mkdir(dir, { recursive: true });
    cacheEnv[variable] = dir;
  }
  return {
    command: profile.testCmd,
    cwd,
    env: { ...profile.env, ...cacheEnv },
    writable: [...Object.values(cacheEnv), ...profile.extraWritePaths],
    readable: profile.extraReadPaths,
    limits: profile.limits,
  };
}
