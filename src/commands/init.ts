import { loadRepoConfig } from '../config.ts';
import { verifySandbox } from '../sandbox/canary.ts';
import { openSandbox, SandboxUnavailableError } from '../sandbox/sandbox.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths, type WorkspacePaths } from '../workspace.ts';

export interface InitResult {
  paths: WorkspacePaths;
  createdWorkspace: boolean;
  updatedGitExclude: boolean;
  /** Undefined when the sandbox works; otherwise why it doesn't. */
  sandboxProblem?: SandboxUnavailableError;
}

export interface InitOptions {
  /** Throws SandboxUnavailableError when no working sandbox is available. */
  checkSandbox?: (repoRoot: string) => Promise<void>;
}

/** Idempotent: safe to re-run in an already initialised repo. */
export async function init(cwd: string, { checkSandbox = checkOsSandbox }: InitOptions = {}): Promise<InitResult> {
  const paths = workspacePaths(await findRepoRoot(cwd));
  const createdWorkspace = await ensureWorkspace(paths);
  const updatedGitExclude = await excludeWorkspaceFromGit(paths.repoRoot);
  // Surface a broken pre-existing config now rather than mid-drill.
  await loadRepoConfig(paths.configFile);

  let sandboxProblem: SandboxUnavailableError | undefined;
  try {
    await checkSandbox(paths.repoRoot);
  } catch (error) {
    if (!(error instanceof SandboxUnavailableError)) throw error;
    sandboxProblem = error;
  }
  return { paths, createdWorkspace, updatedGitExclude, sandboxProblem };
}

async function checkOsSandbox(repoRoot: string): Promise<void> {
  const sandbox = await openSandbox({ repoRoot });
  try {
    await verifySandbox(sandbox, { fresh: true });
  } finally {
    await sandbox.dispose();
  }
}

export const EDITOR_TIP =
  'Tip: disable AI completions inside .fiutsu/ in your editor, so Workouts exercise your own brain.';
