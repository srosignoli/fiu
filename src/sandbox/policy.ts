import { join } from 'node:path';

export const DEFAULT_TIMEOUT_MS = 10_000;

/** Unreadable from Workout code, relative to the user's real home directory. */
export const SECRET_HOME_PATHS = ['.ssh', '.aws', '.config', '.gnupg', '.netrc'];

export interface FilesystemPolicy {
  denyRead: string[];
  allowRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

export interface PolicyContext {
  /** The user's real home directory (not the sandboxed HOME). */
  home: string;
  /** The repository being drilled. Its contents are unreadable except for `readable` paths inside it. */
  repoRoot?: string;
}

export interface PolicyPaths {
  /** Directories that must be readable and writable: the Workout directory, the run's scratch HOME and TMPDIR, toolchain caches. */
  writable: string[];
  /** Extra paths to make readable even inside a denied region. */
  readable?: string[];
  /** Extra paths to make unreadable. */
  denyRead?: string[];
}

/**
 * Reads are allowed except secrets and the repository itself (Workouts never need the repo, and it
 * may hold `.env` files, credentials, or state files). Writes are allowed only where listed.
 */
export function filesystemPolicy(paths: PolicyPaths, context: PolicyContext): FilesystemPolicy {
  return {
    denyRead: [
      ...SECRET_HOME_PATHS.map((path) => join(context.home, path)),
      ...(context.repoRoot ? [context.repoRoot] : []),
      ...(paths.denyRead ?? []),
    ],
    // allowRead wins over a broader denyRead, which keeps a Workout directory inside the repo readable.
    allowRead: [...paths.writable, ...(paths.readable ?? [])],
    allowWrite: paths.writable,
    denyWrite: [],
  };
}

export interface ScrubbedEnvOptions {
  /** Scratch directory used as HOME inside the sandbox. */
  home: string;
  /** Scratch directory used as TMPDIR inside the sandbox. */
  tmp: string;
  /** Variables the Language Profile declares. */
  extra?: Record<string, string>;
  /** The environment to take PATH and LANG from. */
  base?: NodeJS.ProcessEnv;
}

/** An empty environment plus an explicit allowlist: no API keys or tokens ever reach Workout code. */
export function scrubbedEnv({ home, tmp, extra = {}, base = process.env }: ScrubbedEnvOptions): Record<string, string> {
  return {
    PATH: base.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: base.LANG ?? 'C.UTF-8',
    HOME: home,
    TMPDIR: tmp,
    ...extra,
  };
}
