import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import type { LanguageProfile } from '../languages/profile.ts';
import { profileForFile, UnsupportedLanguageError } from '../languages/registry.ts';
import { isDrillableSourcePath } from '../languages/paths.ts';

export interface CommitInfo {
  sha: string;
  subject: string;
  authorEmail: string;
  parents: string[];
  /** A `Co-Authored-By` trailer names an AI coding assistant. */
  aiAuthored: boolean;
}

/** Trailers coding assistants add to the commits they co-author. */
const AI_CO_AUTHOR = /^co-authored-by:.*\b(claude|anthropic|copilot|cursor|codex|openai|chatgpt|gemini|windsurf|codeium|devin|aider|amazon q|codewhisperer|jules)\b/im;

export const isAiAuthored = (message: string) => AI_CO_AUTHOR.test(message);

export async function readCommit(repoRoot: string, rev: string): Promise<CommitInfo> {
  const { stdout } = await execa('git', ['show', '-s', '--format=%H%x00%P%x00%ae%x00%s%x00%B', rev], { cwd: repoRoot });
  const [sha = '', parents = '', authorEmail = '', subject = '', body = ''] = stdout.split('\0');
  return { sha, subject, authorEmail, parents: parents.split(' ').filter(Boolean), aiAuthored: isAiAuthored(body) };
}

/** A merge, rebase, cherry-pick, or revert in progress: commits made now replay changes that already existed. */
export async function operationInProgress(repoRoot: string): Promise<string | undefined> {
  const { stdout } = await execa('git', ['rev-parse', '--git-dir'], { cwd: repoRoot });
  const gitDir = resolve(repoRoot, stdout.trim());
  const markers: [string, string][] = [
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['MERGE_HEAD', 'a merge'],
  ];
  return markers.find(([marker]) => existsSync(join(gitDir, marker)))?.[1];
}


/** Below this many changed lines in the chosen file, a commit is too small to build a Drill around. */
export const MIN_CHANGED_LINES = 5;
/** Above this, the change is a bulk one (initial commit, large refactor, generated code) rather than one focused change. */
export const MAX_CHANGED_LINES = 300;
/** The diff shown to the model is capped; the whole file is always sent alongside it. */
const MAX_DIFF_LINES = 400;

export interface CommitTarget {
  path: string;
  profile: LanguageProfile;
  changedLines: number;
  /** The file as of the commit. */
  source: string;
  /** The commit's diff for this file. */
  diff: string;
}

export type TargetChoice = { target: CommitTarget } | { skip: string };

/**
 * At most one file per commit: among changed files a Language Profile recognises (minus tests,
 * generated, and vendored paths), the one with the most changed lines.
 */
export async function chooseTarget(repoRoot: string, sha: string, profiles: readonly LanguageProfile[]): Promise<TargetChoice> {
  // --no-renames reports a moved file as deleted + added, so every path is a plain path.
  const { stdout } = await execa('git', ['show', '--numstat', '--format=', '--no-renames', sha], { cwd: repoRoot });
  const candidates: { path: string; profile: LanguageProfile; changedLines: number }[] = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [added, removed, path] = line.split('\t');
    // Binary files show "-" counts.
    if (!path || added === '-' || !isDrillableSourcePath(path)) continue;
    let profile: LanguageProfile;
    try {
      profile = profileForFile(path, profiles);
    } catch (error) {
      if (error instanceof UnsupportedLanguageError) continue;
      throw error;
    }
    candidates.push({ path, profile, changedLines: Number(added) + Number(removed) });
  }
  const best = candidates.sort((a, b) => b.changedLines - a.changedLines)[0];
  if (!best) return { skip: 'no changed source file in a supported language (only docs, config, tests, or generated code)' };
  if (best.changedLines < MIN_CHANGED_LINES) return { skip: `too small to drill (${best.changedLines} changed lines in ${best.path})` };
  if (best.changedLines > MAX_CHANGED_LINES) {
    return { skip: `too large to be one focused change (${best.changedLines} changed lines in ${best.path}); drill a part of it with kin drill <file>#<symbol>` };
  }

  const source = await execa('git', ['show', `${sha}:${best.path}`], { cwd: repoRoot, reject: false });
  // The largest change may be a deletion: nothing left to drill.
  if (source.exitCode !== 0) return { skip: `${best.path} no longer exists after the commit` };
  const { stdout: diff } = await execa('git', ['show', '--format=', '--no-renames', sha, '--', best.path], { cwd: repoRoot });
  const diffLines = diff.split('\n');
  const shownDiff =
    diffLines.length > MAX_DIFF_LINES ? [...diffLines.slice(0, MAX_DIFF_LINES), `… (diff truncated: ${diffLines.length - MAX_DIFF_LINES} more lines)`].join('\n') : diff;
  return { target: { ...best, source: source.stdout + '\n', diff: shownDiff } };
}
