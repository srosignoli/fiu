import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { dirname } from 'node:path';

/** How a `--while` command ended. `exitCode` is the shell convention: 128 + the signal number when a signal stopped it. */
export interface CommandResult {
  exitCode: number;
  signal?: NodeJS.Signals;
  durationMs: number;
}

/** After asking a command to stop, how long before it is killed outright. */
export const STOP_GRACE_MS = 5000;
/** Log lines shown when the command fails. */
export const FAILURE_TAIL_LINES = 20;

export interface StartOptions {
  cwd: string;
  logFile: string;
  /** The user's shell; `$SHELL`, else /bin/sh. */
  shell?: string;
}

/**
 * The user's own slow command, run in the background while they practise. It is not Workout code:
 * it runs as if typed, with the full environment and no sandbox. Output goes to a log file, stdin
 * is /dev/null, and it leads its own process group so stopping it stops everything it started.
 */
export class BackgroundCommand {
  readonly command: string;
  readonly logFile: string;
  readonly done: Promise<CommandResult>;
  /** Set once the command has ended. */
  result?: CommandResult;
  /** Whoever told the user how it ended sets this, so it is announced once. */
  reported = false;
  readonly #startedAt = Date.now();
  readonly #pid: number | undefined;
  readonly #killOnExit = () => this.#signal('SIGKILL');

  private constructor(command: string, { cwd, logFile, shell = process.env.SHELL || '/bin/sh' }: StartOptions) {
    this.command = command;
    this.logFile = logFile;
    const log = openSync(logFile, 'w');
    try {
      const child = spawn(shell, ['-c', command], { cwd, stdio: ['ignore', log, log], detached: true });
      this.#pid = child.pid;
      this.done = new Promise((resolve) => {
        const finish = (exitCode: number, signal?: NodeJS.Signals) => {
          process.off('exit', this.#killOnExit);
          this.result = { exitCode, ...(signal ? { signal } : {}), durationMs: Date.now() - this.#startedAt };
          resolve(this.result);
        };
        child.on('error', (error) => {
          // The shell itself could not start: report it in the log, as the shell would have.
          appendFileSync(logFile, `${error.message}\n`);
          finish(127);
        });
        child.on('exit', (code, signal) => finish(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1), signal ?? undefined));
      });
    } finally {
      closeSync(log);
    }
    // If Fiu itself dies, the command must not live on unattended.
    process.on('exit', this.#killOnExit);
  }

  static async start(command: string, options: StartOptions): Promise<BackgroundCommand> {
    await mkdir(dirname(options.logFile), { recursive: true });
    return new BackgroundCommand(command, options);
  }

  elapsedMs(): number {
    return this.result?.durationMs ?? Date.now() - this.#startedAt;
  }

  async tail(lines: number): Promise<string> {
    const text = await readFile(this.logFile, 'utf8').catch(() => '');
    return text.replace(/\n+$/, '').split('\n').slice(-lines).join('\n');
  }

  /** SIGINT to the whole process group, then SIGKILL if it is still running after the grace period. */
  async stop(graceMs = STOP_GRACE_MS): Promise<CommandResult> {
    if (this.result) return this.result;
    this.#signal('SIGINT');
    const timer = setTimeout(() => this.#signal('SIGKILL'), graceMs);
    try {
      return await this.done;
    } finally {
      clearTimeout(timer);
    }
  }

  #signal(signal: NodeJS.Signals) {
    if (this.result || this.#pid === undefined) return;
    try {
      process.kill(-this.#pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** Runs the command in the foreground, output passed straight through: what `--while` does when there is nothing to serve. */
export function runInForeground(command: string, { cwd, shell = process.env.SHELL || '/bin/sh' }: Omit<StartOptions, 'logFile'>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(shell, ['-c', command], { cwd, stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('exit', (code, signal) => resolve(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1)));
  });
}

export function describeDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** `✓ npm test finished in 3m02s`, or the failure with its exit code. */
export function describeResult(command: string, result: CommandResult): string {
  const took = describeDuration(result.durationMs);
  if (result.exitCode === 0) return `✓ \`${command}\` finished in ${took}`;
  if (result.signal) return `✗ \`${command}\` was stopped (${result.signal}) after ${took}`;
  return `✗ \`${command}\` failed (exit ${result.exitCode}) after ${took}`;
}

/** The announcement when a command ends: the result, and on failure the log's last lines. */
export async function reportResult(background: BackgroundCommand, result: CommandResult): Promise<string> {
  const lines = [describeResult(background.command, result)];
  if (result.exitCode !== 0) {
    const tail = await background.tail(FAILURE_TAIL_LINES);
    if (tail) lines.push(tail.replace(/^/gm, '  │ '));
  }
  lines.push(`Log: ${background.logFile}`);
  return lines.join('\n');
}
