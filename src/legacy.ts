import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { legacyAgentFiles } from './agent/install.ts';
import { migrateLegacyHook } from './background/auto.ts';
import { userConfigPath, type ConfigEnv } from './config.ts';
import { excludeWorkspaceFromGit, findRepoRoot, NotAGitRepositoryError, WORKSPACE_DIRNAME } from './workspace.ts';

/** The project's former names, newest first: Fiutsu (v6.0) and Kintsugi (up to v5.1). */
const FORMER_NAMES = [
  { name: 'Fiutsu', workspace: '.fiutsu', config: 'fiutsu' },
  { name: 'Kintsugi', workspace: '.kintsugi', config: 'kintsugi' },
];

export interface LegacyMigration {
  cwd: string;
  configEnv: ConfigEnv;
  /** How to start this `fiu` again, for the replaced hook block. */
  fiuCommand: string[];
}

/**
 * Moves what Fiutsu or Kintsugi left behind to Fiu's names, once: the user config, the repository's
 * workspace, and the background-generation hook. Never overwrites: when the new name already exists, the
 * old ones are left alone; when both former names exist, the newer (Fiutsu) wins.
 * Returns one line per thing moved, plus a reminder when a former name's agent files need replacing.
 */
export async function migrateFromFormerNames({ cwd, configEnv, fiuCommand }: LegacyMigration): Promise<string[]> {
  const notices: string[] = [];

  const configDir = dirname(userConfigPath(configEnv));
  const formerConfig = FORMER_NAMES.map((former) => ({ ...former, dir: join(dirname(configDir), former.config) })).find((former) => existsSync(former.dir));
  if (formerConfig && !existsSync(configDir)) {
    await rename(formerConfig.dir, configDir);
    notices.push(`Moved your ${formerConfig.name} settings from ${formerConfig.dir} to ${configDir}.`);
  }

  let repoRoot: string | undefined;
  try {
    repoRoot = await findRepoRoot(cwd);
  } catch (error) {
    if (!(error instanceof NotAGitRepositoryError)) throw error;
  }
  if (repoRoot) {
    const workspace = join(repoRoot, WORKSPACE_DIRNAME);
    const formerWorkspace = FORMER_NAMES.find((former) => existsSync(join(repoRoot, former.workspace)));
    if (formerWorkspace && !existsSync(workspace)) {
      await rename(join(repoRoot, formerWorkspace.workspace), workspace);
      await excludeWorkspaceFromGit(repoRoot);
      notices.push(`Moved this repository's ${formerWorkspace.workspace}/ to ${WORKSPACE_DIRNAME}/ (${formerWorkspace.name} is now Fiu).`);
    }
    if (await migrateLegacyHook(repoRoot, fiuCommand)) notices.push('Updated the post-commit hook to start Fiu under its new name.');
  }

  if (legacyAgentFiles(configEnv.home, repoRoot).length > 0) {
    notices.push('Your coding agent still has the skill from before Fiu\'s rename: run `fiu agent install claude` (with --project if you installed it that way) to replace it.');
  }
  return notices;
}
