import type { AnyWorkoutOutput, WorkoutKind } from '../synthesis/schema.ts';
import { diffLines, type Hunk } from './diff.ts';

/** A bug the Workout's source file appears to contain already, reported only after an Attempt. */
export interface OriginalDefect {
  /** Lines of the source file (1-based, inclusive). */
  startLine: number;
  endLine: number;
  description: string;
  /** What says so: the bug's lines found in the source, the model's own report, or both. */
  evidence: 'source' | 'model' | 'both';
}

/** Shorter normalised lines (`}`, `else:`, `return`) match too easily to count as evidence. */
export const SIGNIFICANT_LINE_CHARS = 8;

/** A line without its trailing comment or any whitespace. Naive: a comment marker inside a string literal cuts the line there too. */
export function normaliseLine(line: string, lineComment?: string): string {
  const cut = lineComment ? line.indexOf(lineComment) : -1;
  return (cut === -1 ? line : line.slice(0, cut)).replace(/\s+/g, '');
}

/** The correct code and a version with one region changed: a Drill's Starting Code, or a Prediction's Variant. */
type BugPair = { referenceSolution: string; startingCode?: string };

/** The Drill's single changed region: the buggy lines (Starting Code) and the fixed ones (Reference Solution). */
function bugRegion(workout: BugPair): { buggy: string[]; fixed: string[] } | undefined {
  const hunks = diffLines(workout.referenceSolution, workout.startingCode ?? '');
  if (hunks.length !== 1) return undefined;
  const [hunk] = hunks as [Hunk];
  return { buggy: hunk.added, fixed: hunk.removed };
}

/**
 * Where the source file already has the Drill's buggy lines: every significant buggy line appears in
 * it, and no significant fixed line does. Undefined when the bug only removes lines, or doesn't match.
 */
export function matchSource(
  workout: BugPair,
  source: string,
  lineComment?: string,
): { startLine: number; endLine: number } | undefined {
  const region = bugRegion(workout);
  if (!region) return undefined;
  const significant = (lines: string[]) =>
    lines.map((line) => normaliseLine(line, lineComment)).filter((line) => line.length >= SIGNIFICANT_LINE_CHARS);
  const buggy = significant(region.buggy);
  if (buggy.length === 0) return undefined;

  const sourceLines = source.replace(/\r\n?/g, '\n').split('\n').map((line) => normaliseLine(line, lineComment));
  if (significant(region.fixed).some((line) => sourceLines.includes(line))) return undefined;
  const found = buggy.map((line) => sourceLines.indexOf(line) + 1);
  if (found.includes(0)) return undefined;
  return { startLine: Math.min(...found), endLine: Math.max(...found) };
}

/** Combines the source match (Drills only) with the model's report. Undefined when neither says the source has the bug. */
export function findOriginalDefect(
  kind: WorkoutKind,
  workout: AnyWorkoutOutput,
  source: string,
  lineComment?: string,
): OriginalDefect | undefined {
  const sourceLineCount = source.replace(/\n$/, '').split('\n').length;
  const reported = workout.originalDefect;
  // A report with no description or lines outside the file is no report: it never costs a retry.
  const model =
    reported?.description.trim() &&
    Number.isInteger(reported.startLine) &&
    Number.isInteger(reported.endLine) &&
    reported.startLine >= 1 &&
    reported.startLine <= reported.endLine &&
    reported.endLine <= sourceLineCount
      ? reported
      : undefined;
  const match = kind === 'drill' ? matchSource(workout, source, lineComment) : undefined;
  if (match) {
    const description = model?.description.trim() || workout.injectedBugDescription?.trim() || '';
    return { ...match, description, evidence: model ? 'both' : 'source' };
  }
  if (model) return { startLine: model.startLine, endLine: model.endLine, description: model.description.trim(), evidence: 'model' };
  return undefined;
}

/** Comments on the Drill's buggy lines that the fixed lines don't have: they point at the bug. */
export function bugComments(workout: BugPair, lineComment?: string): string[] {
  if (!lineComment) return [];
  const region = bugRegion(workout);
  if (!region) return [];
  const comment = (line: string) => {
    const cut = line.indexOf(lineComment);
    return cut === -1 ? undefined : line.slice(cut).trim();
  };
  const fixed = new Set(region.fixed.map(comment));
  return region.buggy.map(comment).filter((c): c is string => c !== undefined && !fixed.has(c));
}

/**
 * Whether a Previous Version really is the code before the commit. Every region where it differs from
 * the Reference Solution must have a significant line found only in the old file (in it, and not in the
 * new one). When the Previous Version has nothing there (the commit added lines), a Reference Solution
 * line found only in the new file anchors it instead. One line, not all: extraction renames things
 * around a change. Returns each unanchored region: its 1-based line in the Reference Solution, and a line
 * of it that the old file doesn't have, for retry feedback that says what to copy.
 */
export function unanchoredRegions(
  referenceSolution: string,
  previous: string,
  before: string,
  after: string,
  lineComment?: string,
): { line: number; missing: string }[] {
  const lines = (text: string) => new Set(text.replace(/\r\n?/g, '\n').split('\n').map((line) => normaliseLine(line, lineComment)));
  const old = lines(before);
  const now = lines(after);
  const significant = (side: string[]) => side.filter((line) => normaliseLine(line, lineComment).length >= SIGNIFICANT_LINE_CHARS);
  const onlyIn = (has: Set<string>, lacks: Set<string>) => (line: string) => has.has(normaliseLine(line, lineComment)) && !lacks.has(normaliseLine(line, lineComment));
  return diffLines(referenceSolution, previous).flatMap((hunk) => {
    const previousSide = significant(hunk.added);
    const anchored = previousSide.length > 0 ? previousSide.some(onlyIn(old, now)) : significant(hunk.removed).some(onlyIn(now, old));
    if (anchored) return [];
    const missing = previousSide.find((line) => !old.has(normaliseLine(line, lineComment))) ?? previousSide[0] ?? hunk.removed[0] ?? '';
    return [{ line: hunk.line, missing: missing.trim() }];
  });
}
