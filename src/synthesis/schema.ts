import { z } from 'zod';
import { bugComments } from '../verify/defect.ts';
import { diffLines } from '../verify/diff.ts';

export type WorkoutKind = 'drill' | 'kata' | 'prediction';

export const NOUN: Record<WorkoutKind, string> = { drill: 'Drill', kata: 'Kata', prediction: 'Prediction' };

/** What a Workout's Source Anchors must stay silent about before it is solved. */
const SECRET: Record<WorkoutKind, string> = { drill: 'bug', kata: 'missing code', prediction: 'answer' };

/**
 * The fields every Workout output has. Kept to types, enums, and descriptions: providers' structured
 * output support for numeric, length, and pattern constraints varies, so those rules are checked
 * afterwards by `checkWorkoutOutput` and fed back as retry feedback.
 */
function baseFields(kind: WorkoutKind) {
  const noun = NOUN[kind];
  return {
    worthPracticing: z
      .boolean()
      .describe(
        kind === 'prediction'
          ? 'False if no user would ever notice how the target behaves (pure algorithms, plumbing, configuration). When false, explain in notWorthReason and leave every other field empty.'
          : 'False if the target is trivial CRUD, configuration, or glue code. When false, explain in notWorthReason and leave every other field empty.',
      ),
    notWorthReason: z.string().describe('Why the target is not worth practicing; empty when it is.'),
    slug: z.string().describe('URL-safe short slug in kebab-case, e.g. "edf-tie-breaker".'),
    title: z.string().describe(`A short human title for the ${noun}.`),
    pillar: z.enum(['algorithm', 'pattern', 'library']),
    estimatedMinutes: z.number().describe(kind === 'prediction' ? 'How long reading and answering takes: 2 to 5.' : `How long the ${noun} takes a competent developer: 2 to 15.`),
    sourceAnchors: z
      .array(
        z.object({
          startLine: z.number().describe(`First line in the source file (1-based) this ${noun} is derived from.`),
          endLine: z.number().describe('Last line in the source file (inclusive).'),
          explanation: z.string().describe(`What this region does in the original file. Shown ${kind === 'prediction' ? 'after answering' : 'to the developer before solving'}: neutral, silent about the ${SECRET[kind]}.`),
        }),
      )
      .describe(`At least one region of the source file the ${noun} is derived from.`),
  };
}

/** Drills and Katas: code the developer works on. */
function codeFields(kind: 'drill' | 'kata') {
  const drill = kind === 'drill';
  return {
    readmeMarkdown: z
      .string()
      .describe(
        drill
          ? 'A 3 AM incident report: "## Symptom" (observable production behaviour only) and "## Mission". No hints, no cause.'
          : 'A brief: "## What it must do" (the missing unit\'s contract, inputs and outputs, edge cases), "## Where it fits" (one line), "## Mission". Never the missing code itself.',
      ),
    hints: z.array(z.string()).describe(`Exactly 2 hints, gentle first then sharper: nudges in plain words, naming no expression or call from the ${drill ? 'fix' : 'missing code'}.`),
    startingCode: z
      .string()
      .describe(
        drill
          ? 'The complete code file with the single injected bug. No comments pointing at the bug.'
          : 'The complete code file with one region replaced by at most 3 placeholder lines that return a type-correct but wrong value, marked TODO.',
      ),
  };
}

/** The model's report that the source itself looks wrong. Always present, empty when it doesn't, since structured output support for optional fields varies. */
const OriginalDefectSchema = z
  .object({
    startLine: z.number().describe('First line in the source file (1-based) of the defect; 0 when there is none.'),
    endLine: z.number().describe('Last line in the source file (inclusive); 0 when there is none.'),
    description: z.string().describe('What is wrong in the original and why; empty when the original looks right.'),
  })
  .describe('Only when the original source itself looks wrong: where and why. Never shown before solving. Empty (lines 0, description "") otherwise.');

const solutionFields = (kind: WorkoutKind) => ({
  referenceSolution: z
    .string()
    .describe(
      kind === 'prediction'
        ? 'The complete code file, faithful to the original: its behaviour is the true outcome.'
        : `The complete, correct code file. Identical to startingCode except for the ${kind === 'drill' ? 'bug' : 'gap'}.`,
    ),
  testSuiteCode: z.string().describe(kind === 'prediction' ? 'The complete test file: exactly one test per option, each asserting that option\'s outcome.' : 'The complete test file: 3 to 5 tests.'),
  originalDefect: OriginalDefectSchema,
});

export const DrillOutputSchema = z.object({
  ...baseFields('drill'),
  ...codeFields('drill'),
  ...solutionFields('drill'),
  regressionTestName: z.string().describe('The exact name of the test that exposes the bug, named by symptom, never by cause.'),
  injectedBugDescription: z.string().describe('Internal note: exactly what the bug is and why the Regression Test catches it.'),
});
export type DrillOutput = z.infer<typeof DrillOutputSchema>;

export const KataOutputSchema = z.object({
  ...baseFields('kata'),
  ...codeFields('kata'),
  ...solutionFields('kata'),
  gapSummary: z.string().describe('Internal note, never shown: what was removed and what a correct fill must do.'),
});
export type KataOutput = z.infer<typeof KataOutputSchema>;

/** One of a Prediction's four options. The true one has an empty variant and misunderstanding; structured output support for optional fields varies. */
export const PredictionOptionSchema = z.object({
  text: z.string().describe('The outcome, in plain English for someone who never reads code: no names from the code.'),
  testName: z.string().describe('The exact name of the one test that asserts this outcome.'),
  correct: z.boolean().describe('True for exactly one option: what the referenceSolution does.'),
  variant: z
    .object({
      original: z.string().describe('Text that occurs exactly once in referenceSolution, at most 3 lines.'),
      changed: z.string().describe('What replaces it, so the code behaves as this option says.'),
    })
    .describe('For a wrong option: the small change that makes the code do what this option says. Empty strings for the true option.'),
  misunderstanding: z.string().describe('For a wrong option: the wrong idea of the system it stands for, in plain English, shown after answering. Empty for the true option.'),
});
export type PredictionOption = z.infer<typeof PredictionOptionSchema> & { previous?: boolean };

/** In a Prediction from a commit, one wrong option is the code before the commit rather than a Variant. */
const CommitPredictionOptionSchema = PredictionOptionSchema.extend({
  previous: z.boolean().describe('True for exactly one wrong option: what the code did before the commit (its outcome comes from `previous`, so its variant is empty strings).'),
});

export const PredictionOutputSchema = z.object({
  ...baseFields('prediction'),
  scenario: z.string().describe('The situation, in plain English with concrete values, ending in a question about what happens. No names from the code.'),
  options: z.array(PredictionOptionSchema).describe('Exactly 4 options: one true, three wrong ones from Variants.'),
  explanation: z.string().describe('Shown after answering: why the system behaves the way the true option says, in plain English.'),
  ...solutionFields('prediction'),
});
export type PredictionOutput = z.infer<typeof PredictionOutputSchema>;

/** A Prediction from a commit: as PredictionOutputSchema, plus the unit as it was before the commit. */
export const CommitPredictionOutputSchema = PredictionOutputSchema.extend({
  options: z.array(CommitPredictionOptionSchema).describe('Exactly 4 options: the true one, the old behaviour (previous: true), and two wrong ones from Variants.'),
  previous: z.string().describe('The same unit extracted from the file before the commit, made self-contained the same way: the complete code file whose behaviour is the old-behaviour option.'),
});
export type CommitPredictionOutput = z.infer<typeof CommitPredictionOutputSchema>;

/** Any kind, with each kind's own fields optional: what agent mode's submit_drill accepts (the kind comes from prepare_drill). */
export const AnyWorkoutOutputSchema = z.object({
  ...baseFields('drill'),
  ...solutionFields('drill'),
  readmeMarkdown: z.string().optional().describe('Drills and Katas only: the incident report or the brief.'),
  hints: z.array(z.string()).optional().describe('Drills and Katas only: exactly 2 Hints.'),
  startingCode: z.string().optional().describe('Drills and Katas only: the code file the developer receives.'),
  regressionTestName: z.string().optional().describe('Drills only: the test that exposes the bug, named by symptom.'),
  injectedBugDescription: z.string().optional().describe('Drills only: internal note on the bug.'),
  gapSummary: z.string().optional().describe('Katas only: internal note on what was removed and what a correct fill must do.'),
  scenario: z.string().optional().describe('Predictions only: the plain-English situation.'),
  options: z.array(PredictionOptionSchema.extend({ previous: z.boolean().optional() })).optional().describe('Predictions only: exactly 4 options.'),
  previous: z.string().optional().describe('Predictions from a commit only: the unit before the commit.'),
  explanation: z.string().optional().describe('Predictions only: why the true option is true, shown after answering.'),
  originalDefect: OriginalDefectSchema.optional(),
});
export type AnyWorkoutOutput = z.infer<typeof AnyWorkoutOutputSchema>;

export const outputSchemaFor = (kind: WorkoutKind, { fromCommit = false } = {}) =>
  kind === 'drill' ? DrillOutputSchema : kind === 'kata' ? KataOutputSchema : fromCommit ? CommitPredictionOutputSchema : PredictionOutputSchema;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Words that, in text the developer reads before solving a Drill, point at the bug. */
const ANCHOR_SPOILER = /\b(bugs?|buggy|inject\w*|mutat(ed|ion)|faulty|the fix)\b/i;
const README_SPOILER = /\b(inject\w*|mutat(ed|ion))\b/i;
/** A removed line at least this long (trimmed), found verbatim in a Kata's brief or Hints, gives the answer away. */
const KATA_LEAK_MIN_CHARS = 15;

/** A Quick Workout fits in a short wait. */
export const QUICK = { maxMinutes: 5, maxStartingCodeLines: 60 };

/** The rules the schema can't express. Returns human-readable problems; empty when the output is well-formed. */
export function checkWorkoutOutput(
  kind: WorkoutKind,
  output: AnyWorkoutOutput,
  sourceLineCount: number,
  { quick = false, lineComment, fromCommit = false }: { quick?: boolean; lineComment?: string; fromCommit?: boolean } = {},
): string[] {
  const noun = NOUN[kind];
  const problems: string[] = [];
  const empty = (field: string, value: string | undefined) => {
    if (!value?.trim()) problems.push(`${field} is empty.`);
  };
  if (!SLUG.test(output.slug) || output.slug.length > 48) problems.push(`slug "${output.slug}" must be kebab-case, at most 48 characters.`);
  if (output.title.trim() === '') problems.push('title is empty.');
  // Every Prediction is Quick: reading a Scenario and four options is a short wait's work.
  const maxMinutes = kind === 'prediction' ? QUICK.maxMinutes : 15;
  if (!(output.estimatedMinutes >= 2 && output.estimatedMinutes <= maxMinutes)) {
    problems.push(`estimatedMinutes must be between 2 and ${maxMinutes}, not ${output.estimatedMinutes}.`);
  }
  if (output.sourceAnchors.length === 0) problems.push('sourceAnchors must name at least one region of the source file.');
  for (const { startLine, endLine, explanation } of output.sourceAnchors) {
    if (kind === 'drill' && ANCHOR_SPOILER.test(explanation)) {
      problems.push(`source anchor ${startLine}-${endLine}'s explanation gives the bug away ("${explanation}"): describe what the region does in the original, nothing about the bug.`);
    }
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > sourceLineCount) {
      problems.push(`source anchor ${startLine}-${endLine} is not a valid range within the file's ${sourceLineCount} lines.`);
    }
  }
  empty('referenceSolution', output.referenceSolution);
  empty('testSuiteCode', output.testSuiteCode);
  if (kind === 'prediction') return [...problems, ...predictionProblems(output, fromCommit)];

  if (quick) {
    if (output.estimatedMinutes > QUICK.maxMinutes) problems.push(`a Quick ${noun} takes at most ${QUICK.maxMinutes} minutes, not ${output.estimatedMinutes}.`);
    const lines = (output.startingCode ?? '').replace(/\n$/, '').split('\n').length;
    if (lines > QUICK.maxStartingCodeLines) problems.push(`a Quick ${noun}'s startingCode has at most ${QUICK.maxStartingCodeLines} lines, not ${lines}.`);
  }
  const hints = output.hints ?? [];
  if (hints.length !== 2 || hints.some((h) => h.trim() === '')) problems.push('hints must contain exactly 2 non-empty hints.');
  empty('readmeMarkdown', output.readmeMarkdown);
  empty('startingCode', output.startingCode);

  if (kind === 'drill') {
    if (README_SPOILER.test(output.readmeMarkdown ?? '')) problems.push('readmeMarkdown mentions the injected change: describe only what users observed.');
    empty('regressionTestName', output.regressionTestName);
    empty('injectedBugDescription', output.injectedBugDescription);
    const comments = bugComments({ referenceSolution: output.referenceSolution, startingCode: output.startingCode ?? '' }, lineComment);
    if (comments.length > 0) problems.push(`the bug region carries a comment that points at the bug ("${comments[0]}"); remove it.`);
  } else {
    empty('gapSummary', output.gapSummary);
    problems.push(...kataLeaks(output));
  }
  return problems;
}

/** A Prediction has exactly four options. */
export const PREDICTION_OPTIONS = 4;
/** Shorter names (`id`, `max`) are ordinary words too often to count as code vocabulary. */
const CODE_WORD_MIN_CHARS = 4;

/** Names from a code file that read as code: camelCase, PascalCase with an inner capital, or snake_case. */
export function codeVocabulary(code: string): Set<string> {
  const words = code.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  return new Set(words.filter((w) => w.length >= CODE_WORD_MIN_CHARS && (/[a-z][A-Z]/.test(w) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(w))));
}

function predictionProblems(output: AnyWorkoutOutput, fromCommit: boolean): string[] {
  const problems: string[] = [];
  const previous = (output.options ?? []).filter((o) => o.previous);
  if (fromCommit) {
    if (!output.previous?.trim()) problems.push('previous is empty: give the unit as it was before the commit.');
    if (previous.length !== 1) problems.push(`exactly one option must be the old behaviour (previous: true), not ${previous.length}.`);
    if (previous.some((o) => o.correct)) problems.push('the old-behaviour option is wrong by definition: it cannot also be correct.');
  } else if (previous.length > 0 || output.previous) {
    problems.push('only a Prediction from a commit has an old-behaviour option: leave previous empty.');
  }
  if (!output.scenario?.trim()) problems.push('scenario is empty.');
  if (!output.explanation?.trim()) problems.push('explanation is empty.');
  const options = output.options ?? [];
  if (options.length !== PREDICTION_OPTIONS) problems.push(`options must contain exactly ${PREDICTION_OPTIONS} options, not ${options.length}.`);
  const correct = options.filter((o) => o.correct).length;
  if (correct !== 1) problems.push(`exactly one option must be correct, not ${correct}.`);

  const testNames = new Set<string>();
  options.forEach((option, i) => {
    const which = `option ${i + 1}`;
    if (!option.text.trim()) problems.push(`${which}'s text is empty.`);
    if (!option.testName.trim()) problems.push(`${which}'s testName is empty.`);
    else if (testNames.has(option.testName)) problems.push(`${which}'s testName "${option.testName}" is used by another option: each option has its own test.`);
    testNames.add(option.testName);
    if (option.correct || option.previous) {
      const role = option.correct ? 'the correct one' : 'the old behaviour';
      if (option.variant.original || option.variant.changed) problems.push(`${which} is ${role}, so it has no Variant: leave its variant empty.`);
      return;
    }
    if (!option.misunderstanding.trim()) problems.push(`${which}'s misunderstanding is empty: say what wrong idea of the system it stands for.`);
    const { original, changed } = option.variant;
    const found = original ? output.referenceSolution.split(original).length - 1 : 0;
    if (!original) problems.push(`${which}'s variant.original is empty: a wrong option needs a Variant.`);
    else if (found !== 1) problems.push(`${which}'s variant.original occurs ${found} times in referenceSolution; it must occur exactly once.`);
    if (original && original === changed) problems.push(`${which}'s variant changes nothing.`);
  });

  // The Scenario and options are for people who never read code.
  const vocabulary = codeVocabulary(`${output.referenceSolution}\n${output.previous ?? ''}`);
  const shown: [string, string][] = [['the scenario', output.scenario ?? ''], ...options.map((o, i): [string, string] => [`option ${i + 1}'s text`, o.text])];
  for (const [where, text] of shown) {
    const words = (text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []).filter((w) => vocabulary.has(w));
    if (words.length > 0) problems.push(`${where} uses names from the code (${[...new Set(words)].join(', ')}): describe the behaviour in plain English.`);
  }
  return problems;
}

/** Substantial lines of the removed code that appear verbatim in the brief or Hints. */
function kataLeaks(output: AnyWorkoutOutput): string[] {
  const shown = [output.readmeMarkdown ?? '', ...(output.hints ?? [])].join('\n');
  const removed = diffLines(output.referenceSolution, output.startingCode ?? '').flatMap((hunk) => hunk.removed);
  const leaked = removed.map((line) => line.trim()).filter((line) => line.length >= KATA_LEAK_MIN_CHARS && shown.includes(line));
  return leaked.length === 0 ? [] : [`the brief or hints contain the missing code verbatim ("${leaked[0]}"): describe what it must do, never the code itself.`];
}

/** Drill rules, kept for callers that only deal with Drills. */
export const checkDrillOutput = (output: DrillOutput, sourceLineCount: number, options: { quick?: boolean; lineComment?: string } = {}) =>
  checkWorkoutOutput('drill', output, sourceLineCount, options);
