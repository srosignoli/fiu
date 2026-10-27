import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execa } from 'execa';
import { AUTO_DEFAULTS, type Provider, type RepoConfig } from '../config.ts';
import { recordConsent } from '../consent.ts';
import { formatUsd } from '../cost/usage.ts';
import { averageSpend, listWorkouts, readState } from '../workouts/store.ts';
import type { WorkspacePaths } from '../workspace.ts';
import { readLog, type LogEntry } from './log.ts';
import { generationsToday } from './refill.ts';

const BEGIN = '# >>> kintsugi >>>';
const END = '# <<< kintsugi <<<';
/** Marks a hook file Kintsugi created, so `kin auto off` may delete it once its block is gone. */
const CREATED_BY_KINTSUGI = '# Created by Kintsugi (kin auto on).';

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The marked hook block: starts `kin refill --background` for the new commit, fully detached, so the
 * commit never waits. Git sets variables during a commit (e.g. GIT_INDEX_FILE) that would confuse
 * Kintsugi's own git calls, so they're cleared first.
 */
export function hookBlock(kinCommand: string[]): string {
  const command = [...kinCommand, 'refill', '--background', '--commit'].map(quote).join(' ');
  return [
    BEGIN,
    '# Generates a Quick Drill from this commit in the background. `kin auto off` removes this block.',
    `( unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY; nohup ${command} "$(git rev-parse HEAD)" </dev/null >/dev/null 2>&1 & )`,
    END,
  ].join('\n');
}

export type HookInstall =
  | { status: 'installed'; path: string; created: boolean }
  /** core.hooksPath points at a managed (often tracked) hooks directory: the user adds the line themselves. */
  | { status: 'manual'; hooksPath: string; snippet: string };

async function hooksPathSetting(repoRoot: string): Promise<string | undefined> {
  const result = await execa('git', ['config', '--get', 'core.hooksPath'], { cwd: repoRoot, reject: false });
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

async function postCommitPath(repoRoot: string): Promise<string> {
  // `--git-path` resolves correctly for worktrees and custom GIT_DIRs.
  const { stdout } = await execa('git', ['rev-parse', '--git-path', 'hooks/post-commit'], { cwd: repoRoot });
  return resolve(repoRoot, stdout.trim());
}

/** Installs (or refreshes) the marked block in .git/hooks/post-commit, never touching the user's own lines. */
export async function installHook(repoRoot: string, kinCommand: string[]): Promise<HookInstall> {
  const block = hookBlock(kinCommand);
  const hooksPath = await hooksPathSetting(repoRoot);
  if (hooksPath) return { status: 'manual', hooksPath, snippet: block };

  const path = await postCommitPath(repoRoot);
  const existing = existsSync(path) ? await readFile(path, 'utf8') : undefined;
  const content =
    existing === undefined
      ? `#!/bin/sh\n${CREATED_BY_KINTSUGI}\n\n${block}\n`
      : `${appendable(removeBlock(existing))}${block}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (existing === undefined) await chmod(path, 0o755);
  return { status: 'installed', path, created: existing === undefined };
}

/** Removes exactly the marked block; deletes the hook file only if Kintsugi created it and nothing else remains. */
export async function removeHook(repoRoot: string): Promise<{ removed: boolean; path: string }> {
  const path = await postCommitPath(repoRoot);
  if (!existsSync(path)) return { removed: false, path };
  const existing = await readFile(path, 'utf8');
  const remaining = removeBlock(existing);
  if (remaining === existing) return { removed: false, path };
  const leftover = remaining.replace('#!/bin/sh', '').replace(CREATED_BY_KINTSUGI, '').trim();
  if (existing.includes(CREATED_BY_KINTSUGI) && leftover === '') await rm(path);
  else await writeFile(path, remaining);
  return { removed: true, path };
}

export async function hookInstalled(repoRoot: string): Promise<boolean> {
  const path = await postCommitPath(repoRoot);
  return existsSync(path) && (await readFile(path, 'utf8')).includes(BEGIN);
}

function removeBlock(text: string): string {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end < start) return text;
  return (text.slice(0, start) + text.slice(end + END.length)).replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

const appendable = (text: string) => (text === '' ? '' : text.endsWith('\n\n') ? text : text.endsWith('\n') ? `${text}\n` : `${text}\n\n`);

/** Turns background generation on or off in .kintsugi/config.json, keeping every other setting (custom caps included). */
export async function setAuto(configFile: string, enabled: boolean, caps: Partial<NonNullable<RepoConfig['auto']>> = {}, now = new Date()): Promise<void> {
  const raw = existsSync(configFile) ? JSON.parse(await readFile(configFile, 'utf8')) : {};
  raw.auto = { ...raw.auto, ...caps, enabled, ...(enabled ? { consentedAt: now.toISOString() } : {}) };
  await writeFile(configFile, JSON.stringify(raw, null, 2) + '\n');
}

/** The caps in force: config values over the defaults (and nothing else from the `auto` setting). */
export function autoCaps(repoConfig: RepoConfig): typeof AUTO_DEFAULTS {
  const auto: Partial<NonNullable<RepoConfig['auto']>> = repoConfig.auto ?? {};
  return {
    queueCap: auto.queueCap ?? AUTO_DEFAULTS.queueCap,
    dailyLimit: auto.dailyLimit ?? AUTO_DEFAULTS.dailyLimit,
    aiOnly: auto.aiOnly ?? AUTO_DEFAULTS.aiOnly,
    expiryDays: auto.expiryDays ?? AUTO_DEFAULTS.expiryDays,
  };
}

export interface AutoStatus {
  enabled: boolean;
  hookInstalled: boolean;
  caps: typeof AUTO_DEFAULTS;
  generationsToday: number;
  queued: number;
  /** True while the queue is at its cap: background generation waits until a Workout is attempted or discarded. */
  paused: boolean;
  backlog: number;
  recentFailures: LogEntry[];
}

export async function autoStatus(paths: WorkspacePaths, repoConfig: RepoConfig, now = new Date()): Promise<AutoStatus> {
  const state = await readState(paths);
  const caps = autoCaps(repoConfig);
  const queued = (await listWorkouts(paths)).filter((w) => w.status === 'queued').length;
  return {
    enabled: repoConfig.auto?.enabled ?? false,
    hookInstalled: await hookInstalled(paths.repoRoot),
    caps,
    generationsToday: generationsToday(state.spend, now),
    queued,
    paused: queued >= caps.queueCap,
    backlog: state.refill.backlog.length,
    recentFailures: (await readLog(paths)).filter((e) => e.background && e.outcome === 'failed').slice(-3),
  };
}

export class AutoConsentRequiredError extends Error {
  constructor() {
    super('Turning on background generation needs your consent: run `kin auto on` in a terminal, or pass --yes.');
  }
}

export interface EnableAutoOptions {
  paths: WorkspacePaths;
  repoConfig: RepoConfig;
  provider: Provider;
  model: string;
  /** How to start this `kin` from the hook (absolute paths). */
  kinCommand: string[];
  caps?: Partial<Pick<NonNullable<RepoConfig['auto']>, 'queueCap' | 'dailyLimit' | 'aiOnly'>>;
  /** --yes: consent without asking. */
  yes: boolean;
  /** Asks the user; undefined when there's no terminal. */
  confirm?: (message: string) => Promise<boolean>;
  now?: Date;
}

/**
 * `kin auto on`: one explicit consent covering background spending and its caps (and sending code to
 * the provider), then the hook. Returns undefined when the user declines.
 */
export async function enableAuto(options: EnableAutoOptions): Promise<HookInstall | undefined> {
  const { paths, repoConfig, provider, model } = options;
  const caps = { ...autoCaps(repoConfig), ...options.caps };
  if (!options.yes) {
    if (!options.confirm) throw new AutoConsentRequiredError();
    const average = averageSpend((await readState(paths)).spend);
    const message = [
      `After each of your commits, Kintsugi will send the most-changed source file to ${provider} (${model}) and generate a Quick Drill in the background, at your API key's expense.`,
      `Limits: at most ${caps.queueCap} Workouts waiting in the queue, and at most ${caps.dailyLimit} generations a day (retries included)${caps.aiOnly ? ', only for AI-authored commits' : ''}.`,
      ...(average ? [`Your Drills have averaged ${formatUsd(average.usd)} (last ${average.count}).`] : []),
      'Turn background generation on?',
    ].join('\n');
    if (!(await options.confirm(message))) return undefined;
  }
  await setAuto(paths.configFile, true, options.caps, options.now);
  if (repoConfig.consent?.provider !== provider) await recordConsent(paths.configFile, provider, options.now);
  return installHook(paths.repoRoot, options.kinCommand);
}
