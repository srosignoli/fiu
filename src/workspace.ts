import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

export const WORKSPACE_DIRNAME = '.kintsugi';
const EXCLUDE_LINE = `/${WORKSPACE_DIRNAME}/`;

export interface WorkspacePaths {
  repoRoot: string;
  root: string;
  configFile: string;
  stateFile: string;
  workoutsDir: string;
  attemptsDir: string;
  /** The Atlas: what each folder, file, and key function is for. */
  atlasFile: string;
  /** Where v1 moved finished Workouts; no longer written. */
  doneDir: string;
}

export class NotAGitRepositoryError extends Error {
  constructor(cwd: string) {
    super(`${cwd} is not inside a git repository. Run kintsugi from within one.`);
  }
}

export async function findRepoRoot(cwd: string): Promise<string> {
  const result = await execa('git', ['rev-parse', '--show-toplevel'], { cwd, reject: false });
  if (result.exitCode !== 0) throw new NotAGitRepositoryError(cwd);
  return result.stdout.trim();
}

export function workspacePaths(repoRoot: string): WorkspacePaths {
  const root = join(repoRoot, WORKSPACE_DIRNAME);
  return {
    repoRoot,
    root,
    configFile: join(root, 'config.json'),
    stateFile: join(root, 'state.json'),
    workoutsDir: join(root, 'workouts'),
    attemptsDir: join(root, 'attempts'),
    atlasFile: join(root, 'atlas.json'),
    doneDir: join(root, 'done'),
  };
}

/** Creates any missing parts of the workspace; never overwrites existing files. Returns whether anything was created. */
export async function ensureWorkspace(paths: WorkspacePaths): Promise<boolean> {
  const existed = existsSync(paths.root);
  await mkdir(paths.workoutsDir, { recursive: true });
  await writeIfMissing(paths.configFile, '{}\n');
  await writeIfMissing(paths.stateFile, JSON.stringify({ outcomes: [] }, null, 2) + '\n');
  return !existed;
}

/** Hides the workspace from git via the repo-local exclude file (never the tracked .gitignore). Returns whether the file changed. */
export function excludeWorkspaceFromGit(repoRoot: string): Promise<boolean> {
  return excludeFromGit(repoRoot, EXCLUDE_LINE, [`${WORKSPACE_DIRNAME}/`]);
}

/** Adds a pattern to the repo-local exclude file unless it (or an equivalent) is already there. Returns whether the file changed. */
export async function excludeFromGit(repoRoot: string, pattern: string, equivalents: string[] = []): Promise<boolean> {
  // `--git-path` resolves correctly for worktrees and custom GIT_DIRs.
  const { stdout } = await execa('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: repoRoot });
  const excludeFile = resolve(repoRoot, stdout.trim());

  const current = existsSync(excludeFile) ? await readFile(excludeFile, 'utf8') : '';
  const alreadyExcluded = current
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === pattern || equivalents.includes(line));
  if (alreadyExcluded) return false;

  await mkdir(resolve(excludeFile, '..'), { recursive: true });
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await appendFile(excludeFile, `${separator}${pattern}\n`);
  return true;
}

/** True when git tracks the file, which Kintsugi never modifies. */
export async function isTracked(repoRoot: string, path: string): Promise<boolean> {
  const result = await execa('git', ['ls-files', '--error-unmatch', '--', path], { cwd: repoRoot, reject: false });
  return result.exitCode === 0;
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
