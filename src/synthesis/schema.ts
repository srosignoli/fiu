import { z } from 'zod';
import { diffLines } from '../verify/diff.ts';

export type WorkoutKind = 'drill' | 'kata';

/**
 * The fields every Workout output has. Kept to types, enums, and descriptions: providers' structured
 * output support for numeric, length, and pattern constraints varies, so those rules are checked
 * afterwards by `checkWorkoutOutput` and fed back as retry feedback.
 */
function commonFields(kind: WorkoutKind) {
  const drill = kind === 'drill';
  const noun = drill ? 'Drill' : 'Kata';
  return {
    worthPracticing: z
      .boolean()
      .describe('False if the target is trivial CRUD, configuration, or glue code. When false, explain in notWorthReason and leave every other field empty.'),
    notWorthReason: z.string().describe('Why the target is not worth practicing; empty when it is.'),
    slug: z.string().describe('URL-safe short slug in kebab-case, e.g. "edf-tie-breaker".'),
    title: z.string().describe(`A short human title for the ${noun}.`),
    pillar: z.enum(['algorithm', 'pattern', 'library']),
    estimatedMinutes: z.number().describe(`How long the ${noun} takes a competent developer: 2 to 15.`),
    sourceAnchors: z
      .array(
        z.object({
          startLine: z.number().describe(`First line in the source file (1-based) this ${noun} is derived from.`),
          endLine: z.number().describe('Last line in the source file (inclusive).'),
          explanation: z.string().describe(`What this region does in the original file. Shown to the developer before solving: neutral, silent about the ${drill ? 'bug' : 'missing code'}.`),
        }),
      )
      .describe(`At least one region of the source file the ${noun} is derived from.`),
    readmeMarkdown: z
      .string()
      .describe(
        drill
          ? 'A 3 AM incident report: "## Symptom" (observable production behaviour only) and "## Mission". No hints, no cause.'
          : 'A brief: "## What it must do" (the missing unit\'s contract, inputs and outputs, edge cases), "## Where it fits" (one line), "## Mission". Never the missing code itself.',
      ),
    hints: z.array(z.string()).describe(`Exactly 2 hints, gentle first then sharper. Neither states the ${drill ? 'fix' : 'missing code'}.`),
    startingCode: z
      .string()
      .describe(
        drill
          ? 'The complete code file with the single injected bug. No comments pointing at the bug.'
          : 'The complete code file with one region replaced by at most 3 placeholder lines that return a type-correct but wrong value, marked TODO.',
      ),
    referenceSolution: z.string().describe(`The complete, correct code file. Identical to startingCode except for the ${drill ? 'bug' : 'gap'}.`),
    testSuiteCode: z.string().describe('The complete test file: 3 to 5 tests.'),
  };
}

export const DrillOutputSchema = z.object({
  ...commonFields('drill'),
  regressionTestName: z.string().describe('The exact name of the test that exposes the bug, named by symptom, never by cause.'),
  injectedBugDescription: z.string().describe('Internal note: exactly what the bug is and why the Regression Test catches it.'),
});
export type DrillOutput = z.infer<typeof DrillOutputSchema>;

export const KataOutputSchema = z.object({
  ...commonFields('kata'),
  gapSummary: z.string().describe('Internal note, never shown: what was removed and what a correct fill must do.'),
});
export type KataOutput = z.infer<typeof KataOutputSchema>;

/** Either kind, with each kind's own fields optional: what agent mode's submit_drill accepts (the kind comes from prepare_drill). */
export const AnyWorkoutOutputSchema = z.object({
  ...commonFields('drill'),
  regressionTestName: z.string().optional().describe('Drills only: the test that exposes the bug, named by symptom.'),
  injectedBugDescription: z.string().optional().describe('Drills only: internal note on the bug.'),
  gapSummary: z.string().optional().describe('Katas only: internal note on what was removed and what a correct fill must do.'),
});
export type AnyWorkoutOutput = z.infer<typeof AnyWorkoutOutputSchema>;

export const outputSchemaFor = (kind: WorkoutKind) => (kind === 'drill' ? DrillOutputSchema : KataOutputSchema);

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Words that, in text the developer reads before solving a Drill, point at the bug. */
const ANCHOR_SPOILER = /\b(bugs?|buggy|inject\w*|mutat(ed|ion)|faulty|the fix)\b/i;
const README_SPOILER = /\b(inject\w*|mutat(ed|ion))\b/i;
/** A removed line at least this long (trimmed), found verbatim in a Kata's brief or Hints, gives the answer away. */
const KATA_LEAK_MIN_CHARS = 15;

/** A Quick Workout fits in a short wait. */
export const QUICK = { maxMinutes: 5, maxStartingCodeLines: 60 };

/** The rules the schema can't express. Returns human-readable problems; empty when the output is well-formed. */
export function checkWorkoutOutput(kind: WorkoutKind, output: AnyWorkoutOutput, sourceLineCount: number, { quick = false } = {}): string[] {
  const noun = kind === 'drill' ? 'Drill' : 'Kata';
  const problems: string[] = [];
  if (quick) {
    if (output.estimatedMinutes > QUICK.maxMinutes) problems.push(`a Quick ${noun} takes at most ${QUICK.maxMinutes} minutes, not ${output.estimatedMinutes}.`);
    const lines = output.startingCode.replace(/\n$/, '').split('\n').length;
    if (lines > QUICK.maxStartingCodeLines) problems.push(`a Quick ${noun}'s startingCode has at most ${QUICK.maxStartingCodeLines} lines, not ${lines}.`);
  }
  if (!SLUG.test(output.slug) || output.slug.length > 48) problems.push(`slug "${output.slug}" must be kebab-case, at most 48 characters.`);
  if (output.title.trim() === '') problems.push('title is empty.');
  if (!(output.estimatedMinutes >= 2 && output.estimatedMinutes <= 15)) {
    problems.push(`estimatedMinutes must be between 2 and 15, not ${output.estimatedMinutes}.`);
  }
  if (output.hints.length !== 2 || output.hints.some((h) => h.trim() === '')) problems.push('hints must contain exactly 2 non-empty hints.');
  if (output.sourceAnchors.length === 0) problems.push('sourceAnchors must name at least one region of the source file.');
  for (const { startLine, endLine, explanation } of output.sourceAnchors) {
    if (kind === 'drill' && ANCHOR_SPOILER.test(explanation)) {
      problems.push(`source anchor ${startLine}-${endLine}'s explanation gives the bug away ("${explanation}"): describe what the region does in the original, nothing about the bug.`);
    }
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > sourceLineCount) {
      problems.push(`source anchor ${startLine}-${endLine} is not a valid range within the file's ${sourceLineCount} lines.`);
    }
  }
  const required = ['readmeMarkdown', 'startingCode', 'referenceSolution', 'testSuiteCode'] as const;
  for (const field of required) if (output[field].trim() === '') problems.push(`${field} is empty.`);

  if (kind === 'drill') {
    if (README_SPOILER.test(output.readmeMarkdown)) problems.push('readmeMarkdown mentions the injected change: describe only what users observed.');
    for (const field of ['regressionTestName', 'injectedBugDescription'] as const) {
      if (!output[field]?.trim()) problems.push(`${field} is empty.`);
    }
  } else {
    if (!output.gapSummary?.trim()) problems.push('gapSummary is empty.');
    problems.push(...kataLeaks(output));
  }
  return problems;
}

/** Substantial lines of the removed code that appear verbatim in the brief or Hints. */
function kataLeaks(output: AnyWorkoutOutput): string[] {
  const shown = [output.readmeMarkdown, ...output.hints].join('\n');
  const removed = diffLines(output.referenceSolution, output.startingCode).flatMap((hunk) => hunk.removed);
  const leaked = removed.map((line) => line.trim()).filter((line) => line.length >= KATA_LEAK_MIN_CHARS && shown.includes(line));
  return leaked.length === 0 ? [] : [`the brief or hints contain the missing code verbatim ("${leaked[0]}"): describe what it must do, never the code itself.`];
}

/** Drill rules, kept for callers that only deal with Drills. */
export const checkDrillOutput = (output: DrillOutput, sourceLineCount: number, options: { quick?: boolean } = {}) =>
  checkWorkoutOutput('drill', output, sourceLineCount, options);
