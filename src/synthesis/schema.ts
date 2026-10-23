import { z } from 'zod';

/**
 * What the LLM returns for a Drill. Kept to types, enums, and descriptions: providers' structured
 * output support for numeric, length, and pattern constraints varies, so those rules are checked
 * afterwards by `checkDrillOutput` and fed back as retry feedback.
 */
export const DrillOutputSchema = z.object({
  worthPracticing: z
    .boolean()
    .describe('False if the target is trivial CRUD, configuration, or glue code. When false, explain in notWorthReason and leave every other field empty.'),
  notWorthReason: z.string().describe('Why the target is not worth practicing; empty when it is.'),
  slug: z.string().describe('URL-safe short slug in kebab-case, e.g. "edf-tie-breaker".'),
  title: z.string().describe('A short human title for the Drill.'),
  pillar: z.enum(['algorithm', 'pattern', 'library']),
  estimatedMinutes: z.number().describe('How long the Drill takes a competent developer: 2 to 15.'),
  sourceAnchors: z
    .array(
      z.object({
        startLine: z.number().describe('First line in the source file (1-based) this Drill is derived from.'),
        endLine: z.number().describe('Last line in the source file (inclusive).'),
        explanation: z.string().describe('How these lines map to the Drill.'),
      }),
    )
    .describe('At least one region of the source file the Drill is derived from.'),
  readmeMarkdown: z
    .string()
    .describe('A 3 AM incident report: "## Symptom" (observable production behaviour only) and "## Mission". No hints, no cause.'),
  hints: z.array(z.string()).describe('Exactly 2 hints, gentle first then sharper. Neither states the fix.'),
  startingCode: z.string().describe('The complete code file with the single injected bug. No comments pointing at the bug.'),
  referenceSolution: z.string().describe('The complete, correct code file. Identical to startingCode except for the bug.'),
  testSuiteCode: z.string().describe('The complete test file: 3 to 5 tests.'),
  regressionTestName: z.string().describe('The exact name of the test that exposes the bug, named by symptom, never by cause.'),
  injectedBugDescription: z.string().describe('Internal note: exactly what the bug is and why the Regression Test catches it.'),
});
export type DrillOutput = z.infer<typeof DrillOutputSchema>;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The rules the schema can't express. Returns human-readable problems; empty when the output is well-formed. */
export function checkDrillOutput(output: DrillOutput, sourceLineCount: number): string[] {
  const problems: string[] = [];
  if (!SLUG.test(output.slug) || output.slug.length > 48) problems.push(`slug "${output.slug}" must be kebab-case, at most 48 characters.`);
  if (output.title.trim() === '') problems.push('title is empty.');
  if (!(output.estimatedMinutes >= 2 && output.estimatedMinutes <= 15)) {
    problems.push(`estimatedMinutes must be between 2 and 15, not ${output.estimatedMinutes}.`);
  }
  if (output.hints.length !== 2 || output.hints.some((h) => h.trim() === '')) problems.push('hints must contain exactly 2 non-empty hints.');
  if (output.sourceAnchors.length === 0) problems.push('sourceAnchors must name at least one region of the source file.');
  for (const { startLine, endLine } of output.sourceAnchors) {
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > sourceLineCount) {
      problems.push(`source anchor ${startLine}-${endLine} is not a valid range within the file's ${sourceLineCount} lines.`);
    }
  }
  for (const field of ['readmeMarkdown', 'startingCode', 'referenceSolution', 'testSuiteCode', 'regressionTestName', 'injectedBugDescription'] as const) {
    if (output[field].trim() === '') problems.push(`${field} is empty.`);
  }
  return problems;
}
