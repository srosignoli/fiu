/**
 * Everything Kintsugi tells a coding agent. The rules for using the tools live once, in the MCP
 * server instructions (every MCP client receives them); the skill carries only the workflow.
 */

export const SERVER_INSTRUCTIONS = `Kintsugi turns code in this repository into Drills (small debugging exercises), Katas (one piece of the code removed, for the user to rebuild from a brief), and Predictions (a plain-English Scenario about what the code does, with four outcomes to choose from, for people who don't read code), which the user solves by hand. Each one is Verified (its tests are run in a sandbox) before it is saved.

To create a Drill:
1. Call prepare_drill with a file path, optionally \`path#symbol\` to pin a function or class. When the user says what they want to learn rather than naming code, call search_atlas with their words first, and let them choose among its targets. Pass quick: true for a Drill that fits a short wait. A Kata is created the same way, with kind: "kata", and a Prediction with kind: "prediction" (with questions: N, a Series of N Predictions about the unit, submitted together; those that Verify are kept).
2. Write the Drill by following the returned instructions against the numbered source.
3. Call submit_drill with the generationId and the Drill. Kintsugi runs the tests itself.
4. If the result is "rejected", fix every problem in the feedback and submit again. The Drill is done when the result is "saved" or "not-worth-practicing"; when no submissions are left, tell the user it could not be Verified.

To build a Track (3 to 5 Workouts of mixed kinds that teach a newcomer one module, foundations first):
1. Call prepare_track with the module directory. Choose and order the steps from its candidates by its rules, with a kind for each.
2. For each step, in order, create it as above with the kind you chose for it (one of the Track's kinds), passing trackId and a one-line why to prepare_drill. If a step can't be Verified, use another candidate in its place with the same kind, or a Drill on the same file when none is left.
3. Call finish_track with the trackId and a short title. The Track is done when the result is "saved", or "not-enough" when fewer than 3 steps were Verified.

To build the Atlas (what each folder, file, and key function is for, so the user can choose what to practise):
1. Call prepare_atlas with the folder to describe (or none, for the whole repository). It returns the next folder to describe, deepest first, with what to read and the rules.
2. Write the entries from the returned prompt only, and call submit_atlas with the folder, the entries, and the scope you started from. If the result is "rejected", fix every problem and submit again.
3. Repeat with the next pending folder until nothing is pending. The repository root comes last: its entry is the overview.
The Atlas is orientation written by you, not Verified: describe only what the code you were shown does.

Workouts under .kintsugi/ are the user's practice material: leave their files for the user to solve. When the user asks for help with one, give a hint or a guiding question and let them find the fix or write the missing code.`;

export const PREPARE_DESCRIPTION =
  'Start a Drill (or, with kind "kata", a Kata; with kind "prediction", a Prediction) from a source file in this repository. Returns a generationId, the rules for writing it, the numbered source, and the schema submit_drill expects.';

export const SUBMIT_DESCRIPTION =
  'Submit the Drill, Kata, or Prediction written for a generationId. Kintsugi checks it and runs its tests in a sandbox: "saved" returns the Workout id; "rejected" returns feedback to fix before resubmitting; "not-worth-practicing" ends the generation.';

export const PREPARE_TRACK_DESCRIPTION =
  'Start a Track for a module directory: returns a trackId, the candidate files with their outlines, and the rules for choosing and ordering 3 to 5 steps.';

export const FINISH_TRACK_DESCRIPTION =
  'Save a Track once its steps are created: "saved" returns the trackId to start it with; "not-enough" means fewer than 3 steps were Verified (those stay as ordinary Workouts).';

export const PREPARE_ATLAS_DESCRIPTION =
  'Start describing the next folder of the Atlas within a folder (or the whole repository): returns "up-to-date", or the folder to describe, the folders still pending after it, the rules, and a prompt with its subfolders\' entries, declarations, and key functions\' code.';

export const SUBMIT_ATLAS_DESCRIPTION =
  'Submit the Atlas entries for one folder: the folder line (for the repository root, the overview), and every listed file with each of its key functions. "saved" returns the folders still pending; "rejected" returns feedback to fix before resubmitting.';

export const SEARCH_ATLAS_DESCRIPTION =
  'Find files and functions to practise for what the user wants to learn: returns up to 10 targets (path#symbol) best first, each with its Atlas entry and how much the user has practised it. Matches words, so try the domain\'s own terms when the first search finds little.';

export const LIST_DESCRIPTION = "List the Drills waiting to be solved in this repository's Kintsugi queue.";

const stamp = (version: string) => `<!-- kintsugi-version: ${version} -->`;

export const STAMP_PATTERN = /<!-- kintsugi-version: ([^ ]+) -->/;

export function skillMarkdown(version: string): string {
  return `---
name: kintsugi
description: Creates Kintsugi Drills, Katas, Predictions, and Tracks, practice exercises built from this repository's code, and builds the Atlas that says what each part of the code is for, with the kintsugi MCP tools. Use when the user asks for a drill, kata, prediction, workout, or practice exercise on some code, wants to learn, explore, or onboard onto a module, asks for the Kintsugi Atlas or an overview of how the codebase is organised, or an end-of-task rule asks for a Drill.
---

${stamp(version)}

# Creating a Kintsugi Drill

1. **Choose the target.** Use the file or symbol the user named. When the user says what they want to learn instead (\"how retries work\"), call search_atlas with their words (and again with the codebase's own terms if it finds little), propose 2 or 3 of the targets with their Atlas entries, and ask which one before generating. Otherwise pick the unit with the richest logic among the code you have been reading: algorithms, state transitions, concurrency, tricky boundaries. Glue code, configuration, and CRUD make poor Drills. Use quick: true when the user wants a short one, and for end-of-task Drills. Use kind: "kata" when the user asks for a Kata: rebuilding a missing piece rather than finding a bug. Use kind: "prediction" when the user asks for a Prediction, or wants to know what the system does without reading code, with questions: 3 for a Series of three questions about the unit (fewer or more, up to 5, when the user says so; never for end-of-task or Track Predictions); pick the unit whose behaviour users rely on (rules, limits, ordering) rather than the one with the richest logic.

2. **Delegate the generation.** Hand it to a subagent so this conversation stays focused on the user's work. Give it the target, whether it is quick, whether it is an end-of-task Drill (afterTask: true), its kind, and this brief: "Create a Kintsugi Drill (or Kata, or Prediction) with the kintsugi MCP tools prepare_drill and submit_drill, following their instructions, until the result is saved, not worth practicing, or out of submissions. Reply with only the outcome: the Workout id and title, or the reason." Without subagents, do the same steps here.

3. **Report the outcome.** For a saved Drill, give its title and tell the user to start it with \`kin train <workout-id>\`. The bug is the user's to find, so the report names only the symptom the Drill's title describes; for a Kata, the missing code is the user's to write, and for a Prediction the answer is the user's to predict, so the report names only its title. For any other outcome, give the reason and offer a different target.

# Building a Kintsugi Track

When the user wants to learn a module rather than practise one file, build a Track: 3 to 5 Workouts, each from a different file, foundations first, mixing Predictions, Drills, and Katas.

1. **Start it.** Call prepare_track with the module directory the user named, or the one their question is about. When they name a topic rather than a directory, call search_atlas with it and use the folder holding most of the best results. Candidates the Atlas describes come with what they are for instead of their declarations.

2. **Choose and order the steps** from its candidates by its rules: the files the others build on come first, and each step gets a kind from the Track's kinds (at least two different ones when more than one is allowed). Write one line per step saying why it matters for the module.

3. **Delegate the generation.** Hand it to a subagent with the trackId, the ordered steps with their kinds and why lines, and this brief: "For each step in order, create it with prepare_drill (passing trackId, kind, and why) and submit_drill, following their instructions. If a step can't be Verified, use another candidate in its place with the same kind, or a Drill on the same file when none is left. Then call finish_track with the trackId and a short title naming what the module does. Reply with only the outcome." Without subagents, do the same steps here.

4. **Report the outcome.** For a saved Track, give its title and steps, and tell the user to start it with \`kin track <track-id>\`. For "not-enough", say how many steps were Verified and that those Workouts can still be trained with \`kin train\`.

# Building the Kintsugi Atlas

When the user asks for the Atlas, or for an overview of how the codebase is organised to choose what to practise, build or refresh the Atlas.

1. **Delegate it.** Hand it to a subagent with the folder the user named (or none, for the whole repository) and this brief: "Build the Kintsugi Atlas with the kintsugi MCP tools prepare_atlas and submit_atlas, following their instructions: prepare the next folder, write its entries from the prompt alone, submit them with the scope, and repeat until nothing is pending. Reply with only the outcome: how many folders were described, and any that failed." Without subagents, do the same steps here.

2. **Report the outcome.** Tell the user they can see it with \`kin map\`, and search it with \`kin atlas search "<what you want to learn>"\`. Don't summarise the code yourself.

When the user asks for help with a Drill or Kata they are solving (a Prediction gets one answer, so don't help with it before they answer), coach: one hint or guiding question at a time, so they find the fix or write the code themselves.
`;
}

export function commandMarkdown(version: string): string {
  return `---
description: Create a Kintsugi Drill (or Kata, or Prediction) from a file or symbol
argument-hint: "[path[#symbol] | what you want to learn] [quick] [kata|prediction]"
---

${stamp(version)}

Use the kintsugi skill to create a Drill for: $ARGUMENTS
`;
}

export function atlasCommandMarkdown(version: string): string {
  return `---
description: Build or refresh the Kintsugi Atlas, what each folder, file, and key function is for
argument-hint: "[folder]"
---

${stamp(version)}

Use the kintsugi skill to build the Atlas for: $ARGUMENTS (the whole repository when nothing is named)
`;
}

export const BLOCK_BEGIN = '<!-- kintsugi:begin -->';
export const BLOCK_END = '<!-- kintsugi:end -->';

export function afterTasksBlock(version: string): string {
  return `${BLOCK_BEGIN}
${stamp(version)}
When you finish a coding task that changed logic in this repository (more than docs, configuration, or tests), use the kintsugi skill to create a quick Drill from the file you changed most, with afterTask: true. If Kintsugi answers that the queue is full or that file already has a Drill, carry on without one.
${BLOCK_END}`;
}
