import { spawn } from 'node:child_process';

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunProcessOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Runs a shell command in its own process group, so a timeout kills everything it spawned.
 * Output beyond 1 MiB per stream is dropped.
 */
export function runProcess(command: string, { cwd, env, timeoutMs }: RunProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: '/bin/sh', cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    let timedOut = false;

    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      // Reap anything the command left running in the background.
      killGroup();
      resolve({ exitCode, stdout: stdout(), stderr: stderr(), timedOut });
    });
  });
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
