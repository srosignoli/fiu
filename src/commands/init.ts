import { loadRepoConfig } from '../config.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths, type WorkspacePaths } from '../workspace.ts';

export interface InitResult {
  paths: WorkspacePaths;
  createdWorkspace: boolean;
  updatedGitExclude: boolean;
}

/** Idempotent: safe to re-run in an already initialised repo. */
export async function init(cwd: string): Promise<InitResult> {
  const paths = workspacePaths(await findRepoRoot(cwd));
  const createdWorkspace = await ensureWorkspace(paths);
  const updatedGitExclude = await excludeWorkspaceFromGit(paths.repoRoot);
  // Surface a broken pre-existing config now rather than mid-drill.
  await loadRepoConfig(paths.configFile);
  return { paths, createdWorkspace, updatedGitExclude };
}

export const EDITOR_TIP =
  'Tip: disable AI completions inside .kintsugi/ in your editor, so Workouts exercise your own brain.';
