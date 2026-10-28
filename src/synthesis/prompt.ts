import type { LanguageProfile } from '../languages/profile.ts';
import { QUICK, type WorkoutKind } from './schema.ts';

export interface DrillTarget {
  /** Path relative to the repository root, as shown to the model. */
  path: string;
  source: string;
  /** A function, class, or other symbol the user pinned with `file#symbol`. */
  symbol?: string;
  /** The commit that just changed this file: the Drill is built around the change. */
  change?: { sha: string; subject: string; diff: string };
  /** This Drill is one step of a Track teaching a module. */
  track?: { module: string; step: number; of?: number; why: string };
}

/** Above this, the user should pin a symbol in a smaller file rather than have us truncate silently. */
export const MAX_SOURCE_LINES = 3000;

export function drillSystemPrompt(profile: LanguageProfile, { quick = false } = {}): string {
  const quickRules = quick
    ? `\n\nThis is a Quick Drill, for a short wait: pick a small unit, keep startingCode to at most ${QUICK.maxStartingCodeLines} lines, and make estimatedMinutes ${QUICK.maxMinutes} or less.`
    : '';
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
- Write exactly 2 hints in hints (not in the README), gentle first, then sharper. Each is a nudge in plain words: the sharper one narrows down where to look and what to question, and the developer still finds the change. Hints name no expression, operator, or value from the fix.
- sourceAnchors point at the line ranges of the source file the Drill was derived from, using the line numbers shown. The developer reads them in the README before solving, so each explanation is neutral documentation of what that region does in the original file, the same for every line of it, and silent about the bug and the changes you made.

If the file is trivial (CRUD, configuration, glue code, declarations only) and holds no logic worth practicing, set worthPracticing to false, explain why in notWorthReason, and leave the other fields empty.

Rules for this language (${profile.id}):
- The code file is named ${profile.codeFilename} and the test file ${profile.testFilename}.
${profile.promptRules
  .split('\n')
  .map((rule) => `- ${rule}`)
  .join('\n')}${quickRules}`;
}

/** The rules for a Kata: rebuild one missing piece of logic from its contract and tests. */
export function kataSystemPrompt(profile: LanguageProfile, { quick = false } = {}): string {
  const gap = quick ? '5 to 12' : '5 to 25';
  const quickRules = quick
    ? `\n\nThis is a Quick Kata, for a short wait: pick a small unit, keep startingCode to at most ${QUICK.maxStartingCodeLines} lines, and make estimatedMinutes ${QUICK.maxMinutes} or less.`
    : '';
  return `You create Katas: small exercises in which developers rebuild a missing piece of their own codebase's logic, so they keep the ability to write it themselves.

A Kata takes one real unit of code from the developer's repository, makes it self-contained, removes one piece of its logic, and asks the developer to write it back, guided by a brief and by tests.

How to build the Kata:
- Extract one unit (a function, class, or small cluster of them) from the source file. If a symbol is named, use it; otherwise pick the unit whose logic is most worth being able to write.
- Make it self-contained in a single code file. Replace infrastructure the original touches (databases, network, filesystem, clocks, queues, loggers) with small inline fakes or parameters. Keep the interesting logic faithful to the original.
- Remove one contiguous region of ${gap} lines: ideally one function body or one cohesive block, the mechanism that makes the unit work. Replace it with at most 3 placeholder lines that compile and return a type-correct but wrong value (e.g. 0, an empty list, None, the zero value), with a TODO comment. Never throw or raise in the placeholder: the tests must fail by assertion, not crash.
- startingCode and referenceSolution must be identical except for that region.
- Write 3 to 5 tests. Most pin down the missing unit's contract, edge cases included; at least one exercises code outside the gap, so it passes against startingCode. Against startingCode at least one test fails by assertion; against referenceSolution every test passes.
- readmeMarkdown is a brief: "## What it must do" (the missing unit's contract: inputs, outputs, and the edge cases that matter), "## Where it fits" (one line on its role in the original code), and "## Mission" (make all tests pass without changing function signatures). Describe behaviour; never include the missing code.
- Write exactly 2 hints in hints (not in the README), gentle first, then sharper. Each is a nudge in plain words: the sharper one names the idea or approach (e.g. "keep the best seen so far"), and the developer still writes every expression. Hints name no expression, call sequence, or index arithmetic from the missing code.
- gapSummary is an internal note, never shown: what was removed and what a correct fill must do.
- sourceAnchors point at the line ranges of the source file the Kata was derived from, using the line numbers shown, each explained as neutral documentation of what that region does in the original file.

If the file is trivial (CRUD, configuration, glue code, declarations only) and holds no logic worth practicing, set worthPracticing to false, explain why in notWorthReason, and leave the other fields empty.

Rules for this language (${profile.id}):
- The code file is named ${profile.codeFilename} and the test file ${profile.testFilename}.
${profile.promptRules
  .split('\n')
  .map((rule) => `- ${rule}`)
  .join('\n')}${quickRules}`;
}

export const systemPromptFor = (kind: WorkoutKind, profile: LanguageProfile, options: { quick?: boolean } = {}) =>
  kind === 'drill' ? drillSystemPrompt(profile, options) : kataSystemPrompt(profile, options);

export function drillUserPrompt(target: DrillTarget, kind: WorkoutKind = 'drill'): string {
  const noun = kind === 'drill' ? 'Drill' : 'Kata';
  const numbered = target.source
    .replace(/\n$/, '')
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(5)} | ${line}`)
    .join('\n');
  const focus = target.symbol
    ? `Build the ${noun} around \`${target.symbol}\`.`
    : target.change
      ? `This file was just changed by commit ${target.change.sha.slice(0, 12)} ("${target.change.subject}"). Build the ${noun} around the code that changed, so the developer practises understanding it. The source below is the file as of that commit.`
      : 'Pick the unit in this file whose logic is most worth practicing.';
  const change = target.change ? `\n\n<diff>\n${target.change.diff}\n</diff>` : '';
  const track = target.track
    ? `\nThis ${noun} is step ${target.track.step}${target.track.of ? ` of ${target.track.of}` : ''} in a Track teaching a newcomer the module ${target.track.module || '(repository root)'}. This file matters because: ${target.track.why} Build the ${noun} around the logic that makes it matter.`
    : '';
  return `Source file: ${target.path}\n${focus}${track}\n\n<source>\n${numbered}\n</source>${change}`;
}

export function retryPrompt(feedback: string, kind: WorkoutKind = 'drill'): string {
  return `That ${kind === 'drill' ? 'Drill' : 'Kata'} was not Verified, so it was discarded. Here is what the verifier found:

${feedback}

Produce a corrected ${kind === 'drill' ? 'Drill' : 'Kata'} that fixes every problem above.`;
}
