import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { execa } from 'execa';
import { excludeFromGit, findRepoRoot, isTracked } from '../workspace.ts';
import { afterTasksBlock, atlasCommandMarkdown, BLOCK_BEGIN, BLOCK_END, commandMarkdown, skillMarkdown, STAMP_PATTERN } from './texts.ts';

export const MCP_SERVER_NAME = 'fiutsu';

/** `user` installs once for every repository; `project` installs into one repository, untracked. */
export type InstallScope = 'user' | 'project';

export interface ClaudeInstallOptions {
  scope: InstallScope;
  /** Also install the end-of-task instruction (opt-in). */
  afterTasks: boolean;
  version: string;
  home: string;
  cwd: string;
  /** The command that starts `fiu` (absolute paths, so it works whatever PATH the agent has). */
  fiuCommand: string[];
  /** Runs the `claude` CLI; undefined result means it isn't installed. */
  runClaude?: (args: string[], cwd: string) => Promise<{ exitCode: number; output: string } | undefined>;
}

export interface InstallReport {
  written: string[];
  removed: string[];
  /** Set when the MCP server couldn't be registered automatically: the command to run by hand. */
  manualMcpCommand?: string;
}

export class TrackedFileError extends Error {
  constructor(path: string) {
    super(`${path} is tracked by git, and Fiutsu never modifies tracked files. Install at user level instead (without --project).`);
  }
}

interface Targets {
  root: string;
  repoRoot?: string;
  skill: string;
  command: string;
  atlasCommand: string;
  /** The always-loaded instructions file the end-of-task block goes into. */
  memory: string;
  mcpScope: 'user' | 'local';
}

async function targets({ scope, home, cwd }: Pick<ClaudeInstallOptions, 'scope' | 'home' | 'cwd'>): Promise<Targets> {
  if (scope === 'user') {
    const root = join(home, '.claude');
    return {
      root,
      skill: join(root, 'skills', 'fiutsu', 'SKILL.md'),
      command: join(root, 'commands', 'fiu-drill.md'),
      atlasCommand: join(root, 'commands', 'fiu-atlas.md'),
      memory: join(root, 'CLAUDE.md'),
      mcpScope: 'user',
    };
  }
  const repoRoot = await findRepoRoot(cwd);
  const root = join(repoRoot, '.claude');
  return {
    root,
    repoRoot,
    skill: join(root, 'skills', 'fiutsu', 'SKILL.md'),
    command: join(root, 'commands', 'fiu-drill.md'),
    atlasCommand: join(root, 'commands', 'fiu-atlas.md'),
    // The personal, per-repository counterpart of CLAUDE.md.
    memory: join(repoRoot, 'CLAUDE.local.md'),
    // `local` keeps the registration in the user's own Claude config; `project` would write a tracked .mcp.json.
    mcpScope: 'local',
  };
}

/** `fiu agent install claude`: the skill, the /fiu-drill and /fiu-atlas commands, the MCP registration, and optionally the end-of-task block. */
export async function installClaude(options: ClaudeInstallOptions): Promise<InstallReport> {
  const t = await targets(options);
  const report: InstallReport = { written: [], removed: [] };
  const write = async (path: string, content: string) => {
    await guardTracked(t, path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    if (t.repoRoot) await excludeFromGit(t.repoRoot, `/${relative(t.repoRoot, path).split('\\').join('/')}`);
    report.written.push(path);
  };
  const run = options.runClaude ?? runClaudeCli;
  const cwd = t.repoRoot ?? options.cwd;
  await removeLegacyInstall(t, run, cwd, report);

  await write(t.skill, skillMarkdown(options.version));
  await write(t.command, commandMarkdown(options.version));
  await write(t.atlasCommand, atlasCommandMarkdown(options.version));

  const memory = existsSync(t.memory) ? await readFile(t.memory, 'utf8') : '';
  const withoutBlock = removeBlock(memory);
  if (options.afterTasks) {
    const separator = withoutBlock === '' || withoutBlock.endsWith('\n\n') ? '' : withoutBlock.endsWith('\n') ? '\n' : '\n\n';
    await write(t.memory, `${withoutBlock}${separator}${afterTasksBlock(options.version)}\n`);
  } else if (withoutBlock !== memory) {
    await updateOrDelete(t.memory, withoutBlock);
    report.removed.push(`${t.memory} (end-of-task instruction)`);
  }

  const add = ['mcp', 'add', '--scope', t.mcpScope, MCP_SERVER_NAME, '--', ...options.fiuCommand, 'mcp'];
  // Re-registering replaces an older registration (e.g. after moving Fiutsu).
  const removed = await run(['mcp', 'remove', '--scope', t.mcpScope, MCP_SERVER_NAME], cwd);
  const added = removed === undefined ? undefined : await run(add, cwd);
  if (!added || added.exitCode !== 0) report.manualMcpCommand = ['claude', ...add].map(shellWord).join(' ');
  return report;
}

/** `fiu agent uninstall claude`: removes exactly what `install` added. */
export async function uninstallClaude(options: Omit<ClaudeInstallOptions, 'afterTasks' | 'version' | 'fiuCommand'>): Promise<InstallReport> {
  const t = await targets(options);
  const report: InstallReport = { written: [], removed: [] };
  const run = options.runClaude ?? runClaudeCli;
  await removeLegacyInstall(t, run, t.repoRoot ?? options.cwd, report);
  for (const path of [t.skill, t.command, t.atlasCommand]) {
    if (!existsSync(path)) continue;
    // Only files Fiutsu wrote (they carry its stamp).
    if (!STAMP_PATTERN.test(await readFile(path, 'utf8'))) continue;
    await guardTracked(t, path);
    await rm(path);
    report.removed.push(path);
  }
  // The skill's own directory, once empty.
  await rmdir(dirname(t.skill)).catch(() => {});
  if (existsSync(t.memory)) {
    const memory = await readFile(t.memory, 'utf8');
    const withoutBlock = removeBlock(memory);
    if (withoutBlock !== memory) {
      await guardTracked(t, t.memory);
      await updateOrDelete(t.memory, withoutBlock);
      report.removed.push(`${t.memory} (end-of-task instruction)`);
    }
  }
  const result = await run(['mcp', 'remove', '--scope', t.mcpScope, MCP_SERVER_NAME], t.repoRoot ?? options.cwd);
  if (result === undefined) report.manualMcpCommand = `claude mcp remove --scope ${t.mcpScope} ${MCP_SERVER_NAME}`;
  return report;
}

/** The oldest Fiutsu version stamped into the installed agent files, if any are installed. */
export async function installedVersion(home: string, repoRoot?: string): Promise<string | undefined> {
  const paths = [join(home, '.claude', 'skills', 'fiutsu', 'SKILL.md')];
  if (repoRoot) paths.push(join(repoRoot, '.claude', 'skills', 'fiutsu', 'SKILL.md'));
  const versions: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const match = STAMP_PATTERN.exec(await readFile(path, 'utf8'));
    if (match) versions.push(match[1]!);
  }
  return versions.sort(compareVersions)[0];
}

export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** What `agent install` wrote up to v5.1, when Fiutsu was called Kintsugi. */
const LEGACY = {
  serverName: 'kintsugi',
  stamp: /<!-- kintsugi-version: [^ ]+ -->/,
  blockBegin: '<!-- kintsugi:begin -->',
  blockEnd: '<!-- kintsugi:end -->',
  skillDir: (root: string) => join(root, 'skills', 'kintsugi'),
  commands: (root: string) => [join(root, 'commands', 'kin-drill.md'), join(root, 'commands', 'kin-atlas.md')],
};

/** Paths of a Kintsugi agent installation, for telling the user to replace it. */
export function legacyAgentFiles(home: string, repoRoot?: string): string[] {
  const roots = [join(home, '.claude'), ...(repoRoot ? [join(repoRoot, '.claude')] : [])];
  return roots.map((root) => join(LEGACY.skillDir(root), 'SKILL.md')).filter((path) => existsSync(path));
}

/**
 * Removes what a Kintsugi installation added at this scope: only files carrying its stamp, only its
 * marked block, and its MCP registration (only when its files were there, so nobody else's is touched).
 */
async function removeLegacyInstall(t: Targets, run: NonNullable<ClaudeInstallOptions['runClaude']>, cwd: string, report: InstallReport): Promise<void> {
  let found = false;
  for (const path of [join(LEGACY.skillDir(t.root), 'SKILL.md'), ...LEGACY.commands(t.root)]) {
    if (!existsSync(path) || !LEGACY.stamp.test(await readFile(path, 'utf8'))) continue;
    await guardTracked(t, path);
    await rm(path);
    report.removed.push(path);
    found = true;
  }
  await rmdir(LEGACY.skillDir(t.root)).catch(() => {});
  if (existsSync(t.memory)) {
    const memory = await readFile(t.memory, 'utf8');
    const withoutBlock = removeBlock(memory, LEGACY.blockBegin, LEGACY.blockEnd);
    if (withoutBlock !== memory) {
      await guardTracked(t, t.memory);
      await updateOrDelete(t.memory, withoutBlock);
      report.removed.push(`${t.memory} (Kintsugi's end-of-task instruction)`);
      found = true;
    }
  }
  if (found) await run(['mcp', 'remove', '--scope', t.mcpScope, LEGACY.serverName], cwd);
}

function removeBlock(text: string, begin = BLOCK_BEGIN, endMarker = BLOCK_END): string {
  const start = text.indexOf(begin);
  const end = text.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return text;
  const before = text.slice(0, start).replace(/\n+$/, '\n');
  const after = text.slice(end + endMarker.length).replace(/^\n+/, '');
  return before === '\n' ? after : `${before}${after}`;
}

async function updateOrDelete(path: string, content: string): Promise<void> {
  if (content.trim() === '') await rm(path, { force: true });
  else await writeFile(path, content);
}

async function guardTracked(t: Targets, path: string): Promise<void> {
  if (t.repoRoot && (await isTracked(t.repoRoot, path))) throw new TrackedFileError(relative(t.repoRoot, path));
}

async function runClaudeCli(args: string[], cwd: string): Promise<{ exitCode: number; output: string } | undefined> {
  const result = await execa('claude', args, { cwd, reject: false, all: true });
  // With reject: false, a missing binary is a result without an exit code rather than a throw.
  if (result.exitCode === undefined) return undefined;
  return { exitCode: result.exitCode, output: result.all ?? '' };
}

const shellWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);
