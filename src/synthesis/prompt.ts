import type { LanguageProfile } from '../languages/profile.ts';

export interface DrillTarget {
  /** Path relative to the repository root, as shown to the model. */
  path: string;
  source: string;
  /** A function, class, or other symbol the user pinned with `file#symbol`. */
  symbol?: string;
}

/** Above this, the user should pin a symbol in a smaller file rather than have us truncate silently. */
export const MAX_SOURCE_LINES = 3000;

export function drillSystemPrompt(profile: LanguageProfile): string {
  return `You create Drills: small debugging exercises that keep developers fluent in their own codebase.

A Drill takes one real unit of code from the developer's repository, makes it self-contained, injects one realistic bug, and asks the developer to find and fix it, guided by failing tests and an incident report.

How to build the Drill:
- Extract one unit (a function, class, or small cluster of them) from the source file. If a symbol is named, use it; otherwise pick the unit whose logic is most worth understanding.
- Make it self-contained in a single code file. Replace infrastructure the original touches (databases, network, filesystem, clocks, queues, loggers) with small inline fakes or parameters. Keep the interesting logic faithful to the original.
- Inject exactly one realistic, subtle bug into a single region of at most 3 lines, of one of these kinds:
  - algorithmic boundary: off-by-one, inverted tie-breaker, unbounded loop on cyclic input, float drift;
  - concurrency or async: check-then-act race, missing await in a loop, leaked timer or listener;
  - state or mutation: in-place mutation of caller data, shallow-copy aliasing, swallowed error.
- startingCode and referenceSolution must be identical except for that bug region. Never add comments that point at the bug.
- The bug must make tests fail by assertion, not crash: no test may throw an unexpected exception against startingCode.
- Write 3 to 5 tests. Against startingCode, at least one test passes and at least one fails by assertion; against referenceSolution, every test passes.
- The Regression Test is the test that exposes the bug. Name and describe it by the observable symptom ("serves late jobs first when priorities tie"), never by the cause. The developer can read every test.
- readmeMarkdown is a 3 AM incident report: "## Symptom" describes what production users observed, never the cause; "## Mission" says: make all tests pass without changing function signatures.
- Write exactly 2 hints in hints (not in the README), gentle first, then sharper. Neither may state the fix.
- sourceAnchors point at the line ranges of the source file the Drill was derived from, using the line numbers shown.

If the file is trivial (CRUD, configuration, glue code, declarations only) and holds no logic worth practicing, set worthPracticing to false, explain why in notWorthReason, and leave the other fields empty.

Rules for this language (${profile.id}):
- The code file is named ${profile.codeFilename} and the test file ${profile.testFilename}.
${profile.promptRules
  .split('\n')
  .map((rule) => `- ${rule}`)
  .join('\n')}`;
}

export function drillUserPrompt(target: DrillTarget): string {
  const numbered = target.source
    .replace(/\n$/, '')
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(5)} | ${line}`)
    .join('\n');
  const focus = target.symbol
    ? `Build the Drill around \`${target.symbol}\`.`
    : 'Pick the unit in this file whose logic is most worth practicing.';
  return `Source file: ${target.path}\n${focus}\n\n<source>\n${numbered}\n</source>`;
}

export function retryPrompt(feedback: string): string {
  return `That Drill was not Verified, so it was discarded. Here is what the verifier found:

${feedback}

Produce a corrected Drill that fixes every problem above.`;
}
