import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TIMEOUT_MS, filesystemPolicy, scrubbedEnv, type FilesystemPolicy, type PolicyContext } from './policy.ts';
import { runProcess, shellQuote, type ProcessResult } from './process.ts';

export interface RunRequest {
  /** A shell command taken from a Language Profile, never from model output. */
  command: string;
  /** The Workout directory: the command's working directory, readable and writable. */
  cwd: string;
  /** Variables the Language Profile adds to the scrubbed environment. */
  env?: Record<string, string>;
  /** Further writable directories, e.g. toolchain caches. */
  writable?: string[];
  /** Further paths to make readable even inside a denied region. */
  readable?: string[];
  /** Further paths to make unreadable. */
  denyRead?: string[];
  timeoutMs?: number;
}

export type RunResult = ProcessResult;

export interface Sandbox {
  /** False only when the user explicitly opted out with --no-sandbox. */
  readonly isolated: boolean;
  run(request: RunRequest): Promise<RunResult>;
  dispose(): Promise<void>;
}

export class SandboxUnavailableError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(
      ['No working sandbox is available, so Kintsugi will not run Workout code:', ...reasons.map((r) => `  - ${r}`), installHint()]
        .filter(Boolean)
        .join('\n'),
    );
    this.reasons = reasons;
  }
}

function installHint(): string {
  if (process.platform === 'linux') {
    return 'Install the sandbox dependencies (Debian/Ubuntu: `sudo apt-get install bubblewrap socat ripgrep`), or pass --no-sandbox to run this once without isolation.';
  }
  if (process.platform === 'darwin') {
    return 'Install the sandbox dependencies (`brew install ripgrep`), or pass --no-sandbox to run this once without isolation.';
  }
  return 'Kintsugi supports Linux and macOS (on Windows, use WSL). Pass --no-sandbox to run this once without isolation.';
}

type Wrap = (command: string, policy: FilesystemPolicy, commandId: string) => Promise<string>;

/**
 * Each run gets a fresh scratch HOME and TMPDIR, a scrubbed environment, and the filesystem policy;
 * `wrap` turns the command into its sandboxed form.
 */
class ProcessSandbox implements Sandbox {
  readonly isolated: boolean;
  readonly #wrap: Wrap;
  readonly #context: PolicyContext;
  readonly #dispose: () => Promise<void>;

  constructor(isolated: boolean, wrap: Wrap, context: PolicyContext, dispose: () => Promise<void> = async () => {}) {
    this.isolated = isolated;
    this.#wrap = wrap;
    this.#context = context;
    this.#dispose = dispose;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const scratch = await mkdtemp(join(tmpdir(), 'kintsugi-run-'));
    try {
      const home = join(scratch, 'home');
      const tmp = join(scratch, 'tmp');
      await mkdir(home);
      await mkdir(tmp);

      const policy = filesystemPolicy(
        {
          writable: [request.cwd, home, tmp, ...(request.writable ?? [])],
          readable: request.readable,
          denyRead: request.denyRead,
        },
        this.#context,
      );
      // The sandbox runtime forces its own TMPDIR inside the sandbox; point it back at this run's scratch dir.
      const inner = `export TMPDIR=${shellQuote(tmp)}; ${request.command}`;
      const command = await this.#wrap(inner, policy, randomBytes(16).toString('base64url'));
      return await runProcess(command, {
        cwd: request.cwd,
        env: scrubbedEnv({ home, tmp, extra: request.env }),
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  dispose(): Promise<void> {
    return this.#dispose();
  }
}

export interface OpenSandboxOptions {
  /** The repository being drilled; it becomes unreadable to Workout code. */
  repoRoot?: string;
  /** --no-sandbox: when no sandbox works, run without one instead of refusing. Never persisted. */
  allowUnsandboxed?: boolean;
  home?: string;
}

/** Opens the OS sandbox, or throws SandboxUnavailableError (unless the user opted out of isolation). */
export async function openSandbox(options: OpenSandboxOptions = {}): Promise<Sandbox> {
  const context: PolicyContext = { home: options.home ?? homedir(), repoRoot: options.repoRoot };
  try {
    return await openOsSandbox(context);
  } catch (error) {
    if (!(error instanceof SandboxUnavailableError) || !options.allowUnsandboxed) throw error;
    return openUnsandboxed(context);
  }
}

/** No isolation: only the scrubbed environment, scratch HOME, and timeout. For --no-sandbox and tests. */
export function openUnsandboxed(context: PolicyContext = { home: homedir() }): Sandbox {
  return new ProcessSandbox(false, async (command) => command, context);
}

async function openOsSandbox(context: PolicyContext): Promise<Sandbox> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new SandboxUnavailableError([`${process.platform} is not supported.`]);
  }
  // Loaded lazily: the runtime is large, and most commands never run Workout code.
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
  if (!SandboxManager.isSupportedPlatform()) {
    throw new SandboxUnavailableError(['The sandbox runtime does not support this platform.']);
  }
  const dependencies = await SandboxManager.checkDependenciesAsync();
  if (dependencies.errors.length > 0) throw new SandboxUnavailableError(dependencies.errors);

  try {
    await SandboxManager.initialize(
      {
        network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      },
      undefined,
      false,
    );
  } catch (error) {
    throw new SandboxUnavailableError([`The sandbox failed to start: ${(error as Error).message}`]);
  }

  return new ProcessSandbox(
    true,
    (command, filesystem, commandId) =>
      SandboxManager.wrapWithSandbox(command, undefined, { filesystem }, undefined, { commandId }),
    context,
    () => SandboxManager.reset(),
  );
}
