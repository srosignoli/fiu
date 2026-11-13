import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { extractSymbols } from '../atlas/symbols.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import { profileForFile, UnsupportedLanguageError } from '../languages/registry.ts';
import { changedSince, STALE_CHANGED_LINES } from '../map/map.ts';
import type { WorkspacePaths } from '../workspace.ts';
import { readRules, type BusinessRule } from '../atlas/rules.ts';
import type { Skeleton } from '../atlas/skeleton.ts';
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

/** A rule whose latest check is a Prediction not yet answered: its verdict waits, so as not to give the answer away. */
export interface RuleCheckWaiting {
  text: string;
  workoutId: string;
  target: string;
  /** The verdict of the check before it, if there was one. */
  previous?: RuleCheckState;
}

/**
 * Each rule's latest answered check, by the rule's text. A check counts once its Prediction has a finished
 * Attempt: before that its verdict would give the answer away (see `ruleChecksWaiting`).
 */
export async function ruleChecks(paths: WorkspacePaths, profiles: readonly LanguageProfile[]): Promise<Map<string, RuleCheckState>> {
  const latest = new Map<string, Awaited<ReturnType<typeof listWorkouts>>[number]['record']>();
  for (const { record, status } of await listWorkouts(paths)) {
    if (!record.rule || status !== 'attempted') continue;
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

/** Rules whose newest check is a Prediction waiting to be answered (queued or in progress), by the rule's text. */
export async function ruleChecksWaiting(paths: WorkspacePaths, answered: Map<string, RuleCheckState>): Promise<Map<string, RuleCheckWaiting>> {
  const waiting = new Map<string, RuleCheckWaiting>();
  const newest = new Map<string, string>();
  for (const { record, status } of await listWorkouts(paths)) {
    if (!record.rule || status === 'discarded') continue;
    if ((newest.get(record.rule.text) ?? '') > record.createdAt) continue;
    newest.set(record.rule.text, record.createdAt);
    if (status === 'attempted') {
      waiting.delete(record.rule.text);
      continue;
    }
    const previous = answered.get(record.rule.text);
    waiting.set(record.rule.text, { text: record.rule.text, workoutId: record.id, target: record.source.symbol ? `${record.source.path}#${record.source.symbol}` : record.source.path, ...(previous ? { previous } : {}) });
  }
  return waiting;
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

/** A function's code (lines trimmed) at a revision, or undefined when the file or function isn't there. */
async function bodyAt(repoRoot: string, rev: string, path: string, symbol: string, profile: LanguageProfile): Promise<string | undefined> {
  const shown = await execa('git', ['show', `${rev}:${path}`], { cwd: repoRoot, reject: false });
  if (shown.exitCode !== 0) return undefined;
  const found = extractSymbols(shown.stdout, profile.declarationPattern).find((s) => s.name === symbol);
  return found ? shown.stdout.split('\n').slice(found.startLine - 1, found.endLine).map((line) => line.trim()).join('\n') : undefined;
}

/** A rule a commit touched: the rule, the function at its known place, and why that place is known. */
export interface RuleTrigger {
  rule: BusinessRule;
  path: string;
  symbol: string;
  /** `checked`: a Prediction measured it there, so the human confirmed the place; `pinned`: the rules file says so. */
  known: 'checked' | 'pinned';
  /** The verdict of the last answered check, if any. */
  agreed?: boolean;
}

/**
 * The rules a commit touched (ADR 0011): those whose known place is a function the commit changed. A place
 * is known when the rules file pins it, or when a Prediction already checked the rule there; a place Fiu
 * would have to guess never triggers anything. Best first: a rule that held before, then a checked place,
 * then a pinned one. Rules with a check already waiting for an answer are left out.
 */
export async function commitRuleTriggers(paths: WorkspacePaths, skeleton: Skeleton, profiles: readonly LanguageProfile[], sha: string): Promise<RuleTrigger[]> {
  const { rules } = await readRules(paths, skeleton);
  const checked = await ruleChecks(paths, profiles);
  const waiting = await ruleChecksWaiting(paths, checked);
  const triggers: RuleTrigger[] = [];
  for (const rule of rules) {
    if (waiting.has(rule.text)) continue;
    const check = checked.get(rule.text);
    const [checkedPath, checkedSymbol] = check?.target.split('#') ?? [];
    const place = checkedSymbol ? { path: checkedPath!, symbol: checkedSymbol, known: 'checked' as const } : rule.pinned?.symbol ? { path: rule.pinned.path, symbol: rule.pinned.symbol, known: 'pinned' as const } : undefined;
    if (!place) continue;
    let profile: LanguageProfile;
    try {
      profile = profileForFile(place.path, profiles);
    } catch (error) {
      if (error instanceof UnsupportedLanguageError) continue;
      throw error;
    }
    const before = await bodyAt(paths.repoRoot, `${sha}^`, place.path, place.symbol, profile);
    const after = await bodyAt(paths.repoRoot, sha, place.path, place.symbol, profile);
    // Changed, or added by this commit; a function the commit removed has nothing left to check.
    if (after === undefined || before === after) continue;
    triggers.push({ rule, ...place, ...(check ? { agreed: check.agrees } : {}) });
  }
  const rank = (t: RuleTrigger) => (t.agreed === true ? 0 : t.known === 'checked' ? 1 : 2);
  return triggers.sort((a, b) => rank(a) - rank(b));
}
