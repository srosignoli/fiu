import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

/** Why Fiutsu stopped a command before it finished. */
export type StopReason = 'timeout' | 'memory' | 'processes';

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when Fiutsu killed the command. */
  stopped?: StopReason;
}

/**
 * How much a command may use. The per-process memory and process-count limits are enforced by the
 * kernel (rlimits); the totals across the whole process tree are enforced by a watchdog.
 */
export interface ResourceLimits {
  /** Memory any single process may allocate (RLIMIT_DATA). */
  processMemoryMiB: number;
  /** Resident memory of the whole process tree, summed. */
  memoryMiB: number;
  /** Processes in the whole process tree. */
  processes: number;
}

export const DEFAULT_LIMITS: ResourceLimits = { processMemoryMiB: 1024, memoryMiB: 2048, processes: 256 };

/** Headroom over the user's current task count for the kernel's per-user process limit (a fork-bomb backstop). */
const PROCESS_BACKSTOP_HEADROOM = 2048;
const WATCHDOG_INTERVAL_MS = 250;

export interface RunProcessOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  limits?: ResourceLimits;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Runs a shell command in its own process group under resource limits. A timeout or a limit hit
 * kills everything it spawned. Output beyond 1 MiB per stream is dropped.
 */
export async function runProcess(command: string, { cwd, env, timeoutMs, limits = DEFAULT_LIMITS }: RunProcessOptions): Promise<ProcessResult> {
  const limited = `${await rlimitPrefix(limits)} ${command}`;
  return new Promise((resolve, reject) => {
    // bash rather than sh: dash's ulimit has no process-count option.
    const child = spawn(limited, { shell: 'bash', cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    let stopped: StopReason | undefined;

    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const stop = (reason: StopReason, pids: number[] = []) => {
      stopped ??= reason;
      killGroup();
      // A process that left the group (setsid) is still in the tree.
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const watchdog = setInterval(() => {
      void processTree(child.pid!).then(
        (tree) => {
          const rssMiB = tree.reduce((sum, p) => sum + p.rssKiB, 0) / 1024;
          if (tree.length > limits.processes) stop('processes', tree.map((p) => p.pid));
          else if (rssMiB > limits.memoryMiB) stop('memory', tree.map((p) => p.pid));
        },
        () => {
          // ps failed this tick: try again on the next one.
        },
      );
    }, WATCHDOG_INTERVAL_MS);

    child.once('error', (error) => {
      clearTimeout(timer);
      clearInterval(watchdog);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      clearInterval(watchdog);
      // Reap anything the command left running in the background.
      killGroup();
      resolve({ exitCode, stdout: stdout(), stderr: stderr(), ...(stopped ? { stopped } : {}) });
    });
  });
}

/** Human-readable explanation of why a command was stopped, for the runner and for LLM retry feedback. */
export function describeStop(reason: StopReason, limits: ResourceLimits, timeoutMs: number): string {
  switch (reason) {
    case 'timeout':
      return `Stopped: the tests ran for more than ${timeoutMs / 1000} s. Look for an infinite loop or a wait that never ends.`;
    case 'memory':
      return `Stopped: the tests used more than ${formatMiB(limits.memoryMiB)} of memory. Look for a runaway loop or allocation.`;
    case 'processes':
      return `Stopped: the tests started more than ${limits.processes} processes. Look for runaway forking or spawning.`;
  }
}

const formatMiB = (mib: number) => (mib >= 1024 && mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`);

const exec = promisify(execFile);

interface TreeProcess {
  pid: number;
  rssKiB: number;
}

/** The process and all its descendants, with their resident memory. `ps` works the same on Linux and macOS. */
async function processTree(root: number): Promise<TreeProcess[]> {
  const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid=,rss=']);
  const children = new Map<number, TreeProcess[]>();
  const byPid = new Map<number, TreeProcess>();
  for (const line of stdout.split('\n')) {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined || Number.isNaN(ppid)) continue;
    const entry = { pid, rssKiB: rss || 0 };
    byPid.set(pid, entry);
    children.set(ppid, [...(children.get(ppid) ?? []), entry]);
  }
  const tree: TreeProcess[] = [];
  const queue = [byPid.get(root)].filter((p): p is TreeProcess => p !== undefined);
  while (queue.length > 0) {
    const next = queue.shift()!;
    tree.push(next);
    queue.push(...(children.get(next.pid) ?? []));
  }
  return tree;
}

/**
 * `ulimit` settings applied before the command (both soft and hard, so the command can't raise them).
 * The process backstop is relative to the user's current task count, because the kernel counts every
 * process (and on Linux every thread) the user owns, not just this command's.
 */
async function rlimitPrefix(limits: ResourceLimits): Promise<string> {
  const backstop = (await userTaskCount()) + PROCESS_BACKSTOP_HEADROOM;
  return [
    `ulimit -d ${limits.processMemoryMiB * 1024} || exit 125;`,
    // Never above the existing hard limit, which an unprivileged process can't raise.
    `h=$(ulimit -Hu); t=${backstop}; if [ "$h" != unlimited ] && [ "$t" -gt "$h" ]; then t=$h; fi; ulimit -u "$t" || exit 125;`,
  ].join(' ');
}

async function userTaskCount(): Promise<number> {
  const uid = String(process.getuid?.() ?? '');
  try {
    // Linux counts threads against the limit.
    const { stdout } = await exec('ps', ['-L', '-u', uid, '-o', 'pid=']);
    return stdout.trim().split('\n').length;
  } catch {
    // macOS's ps has no -L, and counts processes only.
    const { stdout } = await exec('ps', ['-u', uid, '-o', 'pid=']);
    return stdout.trim().split('\n').length;
  }
}

function capture(stream: NodeJS.ReadableStream): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on('data', (chunk: Buffer) => {
    if (size >= MAX_OUTPUT_BYTES) return;
    chunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - size));
    size += chunk.length;
  });
  return () => Buffer.concat(chunks).toString('utf8');
}
