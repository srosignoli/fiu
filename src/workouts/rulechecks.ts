import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { extractSymbols } from '../atlas/symbols.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import { profileForFile, UnsupportedLanguageError } from '../languages/registry.ts';
import { changedSince, STALE_CHANGED_LINES } from '../map/map.ts';
import type { WorkspacePaths } from '../workspace.ts';
import { listWorkouts } from './store.ts';

/**
 * Rule checks as a living list (ADR 0010): each business rule's latest check, and whether it still holds
 * for today's code. A check measured one function at one commit; once that function changes, what it
 * measured may no longer be true, and the rule is due for a re-check.
 */
export interface RuleCheckState {
  text: string;
  agrees: boolean;
  /** Where it was measured: `path#symbol`, or the path alone. */
  target: string;
  workoutId: string;
  checkedAt: string;
  /** The code it measured has changed since, or is gone: the check may no longer hold. */
  stale: boolean;
  /** Why it is stale, in a few words. */
  staleReason?: string;
}

/** Each rule's latest check, by the rule's text. */
export async function ruleChecks(paths: WorkspacePaths, profiles: readonly LanguageProfile[]): Promise<Map<string, RuleCheckState>> {
  const latest = new Map<string, Awaited<ReturnType<typeof listWorkouts>>[number]['record']>();
  for (const { record } of await listWorkouts(paths)) {
    if (!record.rule) continue;
    const current = latest.get(record.rule.text);
    if (!current || record.createdAt > current.createdAt) latest.set(record.rule.text, record);
  }
  const checks = new Map<string, RuleCheckState>();
  for (const [text, record] of latest) {
    const { path, symbol, commit } = record.source;
    const staleReason = await changedSinceCheck(paths.repoRoot, path, symbol, commit, profiles);
    checks.set(text, {
      text,
      agrees: record.rule!.agrees,
      target: symbol ? `${path}#${symbol}` : path,
      workoutId: record.id,
      checkedAt: record.createdAt,
      stale: staleReason !== undefined,
      ...(staleReason ? { staleReason } : {}),
    });
  }
  return checks;
}

/**
 * Why a check made at `commit` may no longer hold, or undefined while it does: the function it measured
 * changed or is gone; without a function, the file changed by STALE_CHANGED_LINES or more. Without a
 * commit (the file had uncommitted changes when checked), nothing can be compared: it holds.
 */
export async function changedSinceCheck(repoRoot: string, path: string, symbol: string | undefined, commit: string | undefined, profiles: readonly LanguageProfile[]): Promise<string | undefined> {
  if (!commit) return undefined;
  const today = await readFile(join(repoRoot, path), 'utf8').catch(() => undefined);
  if (today === undefined) return 'its file is gone';
  if (symbol) {
    let profile: LanguageProfile;
    try {
      profile = profileForFile(path, profiles);
    } catch (error) {
      if (error instanceof UnsupportedLanguageError) return undefined;
      throw error;
    }
    const then = await execa('git', ['show', `${commit}:${path}`], { cwd: repoRoot, reject: false });
    if (then.exitCode !== 0) return undefined;
    const body = (source: string) => {
      const found = extractSymbols(source, profile.declarationPattern).find((s) => s.name === symbol);
      return found ? source.split('\n').slice(found.startLine - 1, found.endLine).map((line) => line.trim()).join('\n') : undefined;
    };
    const before = body(then.stdout);
    const now = body(today);
    if (before !== undefined) {
      if (now === undefined) return `${symbol} is gone`;
      return before === now ? undefined : `${symbol} changed`;
    }
  }
  const lines = await changedSince(repoRoot, commit, path);
  return lines !== undefined && lines >= STALE_CHANGED_LINES ? `${path} changed by ${lines} lines` : undefined;
}
