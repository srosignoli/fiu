import type { LanguageProfile } from '../languages/profile.ts';
import { answersOnly, NOUN, PREDICTION_OPTIONS, QUICK, WHAT_IF_MAX_CHANGED_LINES, type WorkoutKind } from './schema.ts';

export interface DrillTarget {
  /** Path relative to the repository root, as shown to the model. */
  path: string;
  source: string;
  /** A function, class, or other symbol the user pinned with `file#symbol`. */
  symbol?: string;
  /** The commit that just changed this file: the Drill is built around the change. */
  change?: {
    sha: string;
    subject: string;
    diff: string;
    /** For a Prediction from a commit: the file before it, where the Previous Version is extracted from. */
    before?: string;
  };
  /** A What-if: the change to model, or no sentence to have the model propose one. */
  whatIf?: { sentence?: string };
  /** This Drill is one step of a Track teaching a module, or following a business flow. */
  track?: { module: string; flow?: string; step: number; of?: number; why: string };
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
- Keep the referenceSolution faithful to the original's behaviour. If the original itself looks wrong, don't fix it silently: say where and why in originalDefect (that defect may also be the Drill's bug). Otherwise leave originalDefect empty.
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
- Keep the referenceSolution faithful to the original's behaviour. If the original itself looks wrong, don't fix it silently: say where and why in originalDefect. Otherwise leave originalDefect empty.
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

/** The rules for a Prediction: what the system does in a concrete situation, for people who never read code. */
export function predictionSystemPrompt(profile: LanguageProfile, { fromCommit = false, whatIf = false } = {}): string {
  const commitRules = whatIf
    ? `

This is a What-if: it asks what the code would do with a Proposed Change that has not been made. Here the rule about faithfulness applies to previous, not referenceSolution.
- referenceSolution: the unit with the change made. Its behaviour is the correct option.
- previous: the same unit as it is today, made self-contained the same way and identical to referenceSolution except for the change. Copy the changed lines from the source file as they are. The two may differ by at most ${WHAT_IF_MAX_CHANGED_LINES} lines in all.
- modelledAs: one plain-English sentence with concrete values saying how you understood the change. The human reads it before answering, and it is how they find out if you misread them.
- Choose a Scenario whose outcome is different today and with the change, and ask what happens with the change.
- One wrong option is what happens today: what previous does. Mark it previous: true and leave its variant and misunderstanding empty (Fiu explains it). Every other option has previous: false; the other two wrong options are ordinary Variants of referenceSolution.
- explanation says why the change has this effect.
- If the change is about behaviour that isn't in this file, is too vague to pin down, or needs more than ${WHAT_IF_MAX_CHANGED_LINES} changed lines, set worthPracticing to false and say why in notWorthReason, naming what is missing or where the behaviour seems to live.`
    : fromCommit
    ? `

This is a Prediction from a commit: it asks what the code does now, in a situation the commit changed.
- Choose a Scenario whose outcome is different before and after the commit. If the commit changed no behaviour (a refactor, a rename, a restructuring), set worthPracticing to false and say so in notWorthReason.
- previous: the same unit extracted from the file before the commit, made self-contained the same way and identical to referenceSolution except where the commit changed it. Copy the changed lines from the old file as they are.
- One wrong option is the old behaviour: what previous does. Mark it previous: true and leave its variant and misunderstanding empty (Fiu explains it). Every other option has previous: false; the other two wrong options are ordinary Variants.
- Never mention the commit, or that anything changed, in the scenario or the options.`
    : '';
  return `You create Predictions: short exercises in which people who never read code (engineering managers, architects, developers who let agents write their code) predict what their own system does in a concrete situation, so they keep an accurate picture of it.

A Prediction takes one real unit of code from the repository, makes it self-contained, and asks what happens in a Scenario, with ${PREDICTION_OPTIONS} outcomes to choose from. Every outcome is measured: the true one is what the referenceSolution does, and each wrong one is what a Variant (a small change to it) does. Fiu runs the tests against each to prove it.

How to build the Prediction:
- Extract the unit whose behaviour matters most to the people relying on it: business rules, policies, limits and caps, ordering, state transitions, what is skipped, deferred, retried, or kept. Not the one with the most interesting logic. If a symbol is named, use it.
- Make it self-contained in a single code file. Replace infrastructure the original touches (databases, network, filesystem, clocks, queues, loggers) with small inline fakes or parameters. Keep the behaviour faithful to the original: the referenceSolution must do what the original does. If the original itself looks wrong, don't fix it silently: say where and why in originalDefect. Otherwise leave originalDefect empty.
- scenario: a situation in plain English with concrete values ("3 Workouts are waiting and the cap is 3"), ending in a question about what happens. Never use names from the code (functions, variables, classes); product words a user knows are fine.
- options: exactly ${PREDICTION_OPTIONS}. One is correct: what the referenceSolution does. The other ${PREDICTION_OPTIONS - 1} each stand for one coherent, plausible wrong idea of the system (a different limit, order, or rule), never a random change. Write all ${PREDICTION_OPTIONS} as outcomes of similar length and style, in plain English with no names from the code, so the true one doesn't stand out.
- Each wrong option has a variant: { original, changed }, where original is text that occurs exactly once in referenceSolution (at most 3 lines) and changed replaces it so the code behaves as that option says. The correct option's variant is empty strings. Each wrong option also has a misunderstanding: the wrong idea of the system it stands for, in plain English ("You were picturing a system where a full queue evicts its oldest item.").
- testSuiteCode: exactly ${PREDICTION_OPTIONS} tests, one per option, each named in testName and asserting that option's outcome in the Scenario. Against the referenceSolution, only the correct option's test passes; against each Variant, only that option's test passes. Every other test fails by assertion, never by an unexpected exception.
- explanation: why the system behaves the way the correct option says, in plain English. Shown after answering.
- sourceAnchors point at the line ranges of the source file the Prediction was derived from, using the line numbers shown, each explained as neutral documentation of what that region does. Shown after answering.
- estimatedMinutes is 2 to 5.

If no user would ever notice how the file behaves (pure algorithms, plumbing, configuration, declarations only), set worthPracticing to false, explain why in notWorthReason, and leave the other fields empty.

Rules for this language (${profile.id}):
- The code file is named ${profile.codeFilename} and the test file ${profile.testFilename}.
${profile.promptRules
  .split('\n')
  .map((rule) => `- ${rule}`)
  .join('\n')}${commitRules}`;
}

/** The rules for a Diagnosis: which Cause explains a practice incident, for people who never read code. */
export function diagnosisSystemPrompt(profile: LanguageProfile): string {
  return `You create Diagnoses: short exercises in which people who never read code (engineering managers, architects, developers who let agents write their code) read a practice incident about their own system and choose what caused it, so they can reason about real incidents.

A Diagnosis takes one real unit of code from the repository, makes it self-contained, and offers ${PREDICTION_OPTIONS} possible Causes. Every link is measured: the referenceSolution is the healthy code, and each Cause is a Variant (a small change to it) with a test that asserts the Cause's Symptom. Fiu runs the tests against all five versions to prove it.

How to build the Diagnosis:
- Extract the unit whose behaviour matters most to the people relying on it: business rules, limits and caps, ordering, state transitions, what is skipped, deferred, retried, or kept. If a symbol is named, use it.
- Make it self-contained in a single code file. Replace infrastructure the original touches (databases, network, filesystem, clocks, queues, loggers) with small inline fakes or parameters. Keep the behaviour faithful to the original: the referenceSolution must do what the original does. If the original itself looks wrong, don't fix it silently: say where and why in originalDefect. Otherwise leave originalDefect empty.
- causes: exactly ${PREDICTION_OPTIONS}, each a realistic way this system could go wrong, one marked correct. Write them as explanations of similar length and style, in plain English with no names from the code (functions, variables, classes); product words a user knows are fine. The true one must not stand out.
- The human must need a picture of how this system works to choose, not just a careful reading of the incident. Every wrong Cause is one a reasonable person would suspect on reading the incident: it concerns the same people, things, and moment, and sounds as if it could explain what users saw. Only knowing how the system really works, or thinking its rules through, rules it out. If only one Cause shares words with the incident, or the incident contains a comparison that points at one Cause, rewrite them.
- Each Cause has a variant: { original, changed }, where original is text that occurs exactly once in referenceSolution (at most 3 lines) and changed replaces it so the code really has that Cause. The true Cause has one too. All ${PREDICTION_OPTIONS} are different changes.
- Each Cause has a symptom: what users would see if it were real, in plain English with concrete values ("a job cancelled at 9 o'clock still ran at 10"). The correct Cause's symptom is the incident the human reads, so it is written as a user would report it: what happened and never why, without side-by-side comparisons or details included only because they single out the true Cause. Each Cause's symptom differs from the others'.
- testSuiteCode: exactly ${PREDICTION_OPTIONS} tests, one per Cause, each named in testName and asserting that Cause's Symptom. Against the referenceSolution, every test fails by assertion: the healthy code shows no Symptom. Against each Variant, only that Cause's test passes and the others fail by assertion, never by an unexpected exception.
- explanation: why the true Cause produces the incident, in plain English. Shown after answering.
- title names what users saw, never the Cause.
- sourceAnchors point at the line ranges of the source file the Diagnosis was derived from, using the line numbers shown, each explained as neutral documentation of what that region does. Shown after answering.
- estimatedMinutes is 2 to 5.

If no user would ever notice how the file behaves (pure algorithms, plumbing, configuration, declarations only), set worthPracticing to false, explain why in notWorthReason, and leave the other fields empty.

Rules for this language (${profile.id}):
- The code file is named ${profile.codeFilename} and the test file ${profile.testFilename}.
${profile.promptRules
  .split('\n')
  .map((rule) => `- ${rule}`)
  .join('\n')}`;
}

/** Appended to the Prediction rules for a Series of `count` questions. */
export function seriesRules(count: number): string {
  return `

This is a Series: ${count} Predictions about the same unit, generated together. Extract the unit once (one referenceSolution, sourceAnchors, and originalDefect, shared by every question), then write ${count} questions in \`questions\`.
- Each question asks about a different rule or behaviour of the unit (a limit, an order, what is skipped, what happens on failure), never the same one in other words. No two questions may share a Scenario, a correct outcome, or a Variant.
- Each question has its own slug, title, estimatedMinutes, scenario, ${PREDICTION_OPTIONS} options with their Variants and misunderstandings, explanation, and testSuiteCode with exactly ${PREDICTION_OPTIONS} tests, one per option, all against the shared referenceSolution.
- Every rule above for a single Prediction applies to each question.`;
}

export function seriesRetryPrompt(feedback: string, saved: number, needed: number): string {
  return `${saved > 0 ? `${saved} question(s) of the Series were Verified and are saved. ` : ''}These were not Verified, so they were discarded:

${feedback}

Write ${needed} replacement question(s), as a Series whose \`questions\` holds only the replacements. Each is Verified against the referenceSolution you return with it, and must ask about something no saved question asks about.`;
}

export const systemPromptFor = (kind: WorkoutKind, profile: LanguageProfile, options: { quick?: boolean; fromCommit?: boolean; whatIf?: boolean } = {}) =>
  kind === 'drill' ? drillSystemPrompt(profile, options) : kind === 'kata' ? kataSystemPrompt(profile, options) : kind === 'diagnosis' ? diagnosisSystemPrompt(profile) : predictionSystemPrompt(profile, options);

export function drillUserPrompt(target: DrillTarget, kind: WorkoutKind = 'drill'): string {
  const noun = NOUN[kind];
  const numbered = target.source
    .replace(/\n$/, '')
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(5)} | ${line}`)
    .join('\n');
  const proposed = target.whatIf
    ? target.whatIf.sentence
      ? ` The Proposed Change, in the human's words: "${target.whatIf.sentence}".`
      : ' Propose one small change to its behaviour that someone responsible for this system might plausibly ask for, and model it.'
    : '';
  const focus = target.whatIf && !target.symbol
    ? `Build the ${noun} around the unit this change concerns.${proposed}`
    : target.symbol
    ? `Build the ${noun} around \`${target.symbol}\`.`
    : target.change?.before !== undefined
      ? `This file was just changed by commit ${target.change.sha.slice(0, 12)} ("${target.change.subject}"). Build the ${noun} around behaviour the commit changed. The source below is the file as of that commit; the file before it follows the diff.`
      : target.change
        ? `This file was just changed by commit ${target.change.sha.slice(0, 12)} ("${target.change.subject}"). Build the ${noun} around the code that changed, so the developer practises understanding it. The source below is the file as of that commit.`
      : answersOnly(kind)
        ? 'Pick the unit in this file whose behaviour matters most to the people relying on it.'
        : 'Pick the unit in this file whose logic is most worth practicing.';
  const before = target.change?.before !== undefined ? `\n\n<source-before-commit>\n${target.change.before.replace(/\n$/, '')}\n</source-before-commit>` : '';
  const change = target.change ? `\n\n<diff>\n${target.change.diff}\n</diff>${before}` : '';
  const track = target.track
    ? target.track.flow
      ? `\nThis ${noun} is step ${target.track.step}${target.track.of ? ` of ${target.track.of}` : ''} in a Track following the business flow "${target.track.flow}" through the code, in the order the flow runs. What this file does in the flow: ${target.track.why} Build the ${noun} around the logic that does it.`
      : `\nThis ${noun} is step ${target.track.step}${target.track.of ? ` of ${target.track.of}` : ''} in a Track teaching a newcomer the module ${target.track.module || '(repository root)'}. This file matters because: ${target.track.why} Build the ${noun} around the logic that makes it matter.`
    : '';
  return `Source file: ${target.path}\n${focus}${target.symbol ? proposed : ''}${track}\n\n<source>\n${numbered}\n</source>${change}`;
}

export function retryPrompt(feedback: string, kind: WorkoutKind = 'drill'): string {
  return `That ${NOUN[kind]} was not Verified, so it was discarded. Here is what the verifier found:

${feedback}

Produce a corrected ${NOUN[kind]} that fixes every problem above.`;
}
