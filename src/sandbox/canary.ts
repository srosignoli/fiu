import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { arch, homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userCacheDir } from '../config.ts';
import { SECRET_HOME_PATHS } from './policy.ts';
import { SandboxUnavailableError, type Sandbox } from './sandbox.ts';

const CANARY_ENV_VAR = 'KINTSUGI_CANARY_SECRET';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Runs inside the sandbox; every probe except `writeInside` must be refused. */
const CANARY_SCRIPT = `
import { connect } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outsideDir, ...secretPaths] = process.argv.slice(2);
const attempt = (fn) => { try { fn(); return 'allowed'; } catch { return 'refused'; } };
const network = await new Promise((resolve) => {
  const socket = connect({ host: '1.1.1.1', port: 443, timeout: 3000 });
  socket.once('connect', () => { socket.destroy(); resolve('allowed'); });
  socket.once('timeout', () => { socket.destroy(); resolve('refused'); });
  socket.once('error', () => resolve('refused'));
});
console.log(JSON.stringify({
  network,
  writeInside: attempt(() => writeFileSync(join(process.cwd(), 'inside.txt'), 'x')),
  writeOutside: attempt(() => writeFileSync(join(outsideDir, 'escaped.txt'), 'x')),
  reads: Object.fromEntries(secretPaths.map((path) => [path, attempt(() => readFileSync(path))])),
  env: Object.keys(process.env),
}));
`;

export interface CanaryReport {
  passed: boolean;
  /** Human-readable reasons the canary failed; empty when it passed. */
  failures: string[];
}

interface CanaryOutput {
  network: string;
  writeInside: string;
  writeOutside: string;
  reads: Record<string, string>;
  env: string[];
}

/** Proves the sandbox refuses network access, writes outside the Workout, secret reads, and leaked env vars. */
export async function runCanary(sandbox: Sandbox, home: string = homedir()): Promise<CanaryReport> {
  const workDir = await mkdtemp(join(tmpdir(), 'kintsugi-canary-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'kintsugi-canary-outside-'));
  // A secret we know exists, so the read denial is proven even on machines without ~/.ssh.
  const plantedSecret = join(outsideDir, 'secret');
  const secrets = [plantedSecret, ...(await existingSecretFiles(home))];
  const previousEnvValue = process.env[CANARY_ENV_VAR];
  try {
    await writeFile(plantedSecret, 'canary');
    await writeFile(join(workDir, 'canary.mjs'), CANARY_SCRIPT);
    process.env[CANARY_ENV_VAR] = 'must-not-leak';

    const result = await sandbox.run({
      command: [process.execPath, 'canary.mjs', outsideDir, ...secrets].map(shellQuote).join(' '),
      cwd: workDir,
      denyRead: [plantedSecret],
    });
    const output = parseOutput(result.stdout);
    if (!output) {
      return fail([`The canary did not run inside the sandbox (exit ${result.exitCode}): ${result.stderr.trim()}`]);
    }

    const failures: string[] = [];
    if (output.network !== 'refused') failures.push('Network access was not blocked.');
    if (output.writeInside !== 'allowed') failures.push('Writing inside the Workout directory was blocked.');
    if (output.writeOutside !== 'refused') failures.push('Writing outside the Workout directory was not blocked.');
    for (const [path, outcome] of Object.entries(output.reads)) {
      if (outcome !== 'refused') failures.push(`Reading ${path} was not blocked.`);
    }
    if (output.env.includes(CANARY_ENV_VAR)) failures.push('Environment variables leaked into the sandbox.');
    return failures.length === 0 ? { passed: true, failures } : fail(failures);
  } finally {
    if (previousEnvValue === undefined) delete process.env[CANARY_ENV_VAR];
    else process.env[CANARY_ENV_VAR] = previousEnvValue;
    await rm(workDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
}

/**
 * One real file per secret location. Files are probed rather than directories because the Linux
 * sandbox hides a denied directory behind an empty mount: listing it succeeds but shows nothing.
 */
async function existingSecretFiles(home: string): Promise<string[]> {
  const files: string[] = [];
  for (const path of SECRET_HOME_PATHS.map((p) => join(home, p))) {
    const file = await findFile(path, 2);
    if (file) files.push(file);
  }
  return files;
}

async function findFile(path: string, depth: number): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.isFile()) return path;
    if (!info.isDirectory() || depth === 0) return undefined;
    for (const entry of await readdir(path)) {
      const file = await findFile(join(path, entry), depth - 1);
      if (file) return file;
    }
  } catch {
    // Unreadable or vanished: nothing to probe.
  }
  return undefined;
}

export interface VerifySandboxOptions {
  /** Skip the cache (kin init always re-checks). */
  fresh?: boolean;
  cacheDir?: string;
}

/**
 * Throws SandboxUnavailableError unless the canary passes. Passes are cached for a week per
 * platform, Node version, and sandbox-runtime version. Unisolated sandboxes are not checked.
 */
export async function verifySandbox(sandbox: Sandbox, { fresh = false, cacheDir = userCacheDir() }: VerifySandboxOptions = {}) {
  if (!sandbox.isolated) return;
  const cacheFile = join(cacheDir, 'sandbox-canary.json');
  const key = await cacheKey();
  if (!fresh && (await cachedPass(cacheFile, key))) return;

  const report = await runCanary(sandbox);
  if (!report.passed) throw new SandboxUnavailableError(report.failures);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ key, passedAt: new Date().toISOString() }) + '\n');
}

async function cachedPass(cacheFile: string, key: string): Promise<boolean> {
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    return cached.key === key && Date.now() - Date.parse(cached.passedAt) < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

async function cacheKey(): Promise<string> {
  const runtimeEntry = fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'));
  const { version } = JSON.parse(await readFile(join(dirname(runtimeEntry), '..', 'package.json'), 'utf8'));
  return [process.platform, arch(), process.version, version].join('|');
}

function parseOutput(stdout: string): CanaryOutput | undefined {
  const line = stdout.trim().split('\n').at(-1);
  try {
    return line ? (JSON.parse(line) as CanaryOutput) : undefined;
  } catch {
    return undefined;
  }
}

const fail = (failures: string[]): CanaryReport => ({ passed: false, failures });

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
