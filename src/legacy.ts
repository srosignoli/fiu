import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { legacyAgentFiles } from './agent/install.ts';
import { migrateLegacyHook } from './background/auto.ts';
import { userConfigPath, type ConfigEnv } from './config.ts';
import { excludeWorkspaceFromGit, findRepoRoot, NotAGitRepositoryError, WORKSPACE_DIRNAME } from './workspace.ts';

/** Up to v5.1 Fiutsu was called Kintsugi: its workspace directory. */
export const LEGACY_WORKSPACE_DIRNAME = '.kintsugi';
/** Its user-level config directory, beside Fiutsu's (it can hold API keys). */
const LEGACY_CONFIG_DIRNAME = 'kintsugi';

export interface LegacyMigration {
  cwd: string;
  configEnv: ConfigEnv;
  /** How to start this `fiu` again, for the replaced hook block. */
  fiuCommand: string[];
}

/**
 * Moves what Kintsugi left behind to Fiutsu's names, once: the user config, the repository's workspace,
 * and the background-generation hook. Never overwrites: when both names exist, the old one is left alone.
 * Returns one line per thing moved, plus a reminder when Kintsugi's agent files need replacing.
 */
export async function migrateFromKintsugi({ cwd, configEnv, fiuCommand }: LegacyMigration): Promise<string[]> {
  const notices: string[] = [];

  const configDir = dirname(userConfigPath(configEnv));
  const legacyConfigDir = join(dirname(configDir), LEGACY_CONFIG_DIRNAME);
  if (existsSync(legacyConfigDir) && !existsSync(configDir)) {
    await rename(legacyConfigDir, configDir);
    notices.push(`Moved your Kintsugi settings from ${legacyConfigDir} to ${configDir}.`);
  }

  let repoRoot: string | undefined;
  try {
    repoRoot = await findRepoRoot(cwd);
  } catch (error) {
    if (!(error instanceof NotAGitRepositoryError)) throw error;
  }
  if (repoRoot) {
    const legacyWorkspace = join(repoRoot, LEGACY_WORKSPACE_DIRNAME);
    const workspace = join(repoRoot, WORKSPACE_DIRNAME);
    if (existsSync(legacyWorkspace) && !existsSync(workspace)) {
      await rename(legacyWorkspace, workspace);
      await excludeWorkspaceFromGit(repoRoot);
      notices.push(`Moved this repository's ${LEGACY_WORKSPACE_DIRNAME}/ to ${WORKSPACE_DIRNAME}/ (Kintsugi is now Fiutsu).`);
    }
    if (await migrateLegacyHook(repoRoot, fiuCommand)) notices.push('Updated the post-commit hook to start Fiutsu instead of Kintsugi.');
  }

  if (legacyAgentFiles(configEnv.home, repoRoot).length > 0) {
    notices.push('Your coding agent still has Kintsugi\'s skill: run `fiu agent install claude` (with --project if you installed it that way) to replace it.');
  }
  return notices;
}
