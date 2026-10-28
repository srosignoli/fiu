/**
 * Everything Kintsugi tells a coding agent. The rules for using the tools live once, in the MCP
 * server instructions (every MCP client receives them); the skill carries only the workflow.
 */

export const SERVER_INSTRUCTIONS = `Kintsugi turns code in this repository into Drills (small debugging exercises) and Katas (one piece of the code removed, for the user to rebuild from a brief), which the user solves by hand. Each one is Verified (its tests are run in a sandbox) before it is saved.

To create a Drill:
1. Call prepare_drill with a file path, optionally \`path#symbol\` to pin a function or class. Pass quick: true for a Drill that fits a short wait. A Kata is created the same way, with kind: "kata".
2. Write the Drill by following the returned instructions against the numbered source.
3. Call submit_drill with the generationId and the Drill. Kintsugi runs the tests itself.
4. If the result is "rejected", fix every problem in the feedback and submit again. The Drill is done when the result is "saved" or "not-worth-practicing"; when no submissions are left, tell the user it could not be Verified.

To build a Track (3 to 5 Drills that teach a newcomer one module, foundations first):
1. Call prepare_track with the module directory. Choose and order the steps from its candidates by its rules.
2. For each step, in order, create the Drill as above, passing trackId and a one-line why to prepare_drill. If a step can't be Verified, use another candidate in its place.
3. Call finish_track with the trackId and a short title. The Track is done when the result is "saved", or "not-enough" when fewer than 3 steps were Verified.

Workouts under .kintsugi/ are the user's practice material: leave their files for the user to solve. When the user asks for help with one, give a hint or a guiding question and let them find the fix or write the missing code.`;

export const PREPARE_DESCRIPTION =
  'Start a Drill (or, with kind "kata", a Kata) from a source file in this repository. Returns a generationId, the rules for writing it, the numbered source, and the schema submit_drill expects.';

export const SUBMIT_DESCRIPTION =
  'Submit the Drill or Kata written for a generationId. Kintsugi checks it and runs its tests in a sandbox: "saved" returns the Workout id; "rejected" returns feedback to fix before resubmitting; "not-worth-practicing" ends the generation.';

export const PREPARE_TRACK_DESCRIPTION =
  'Start a Track for a module directory: returns a trackId, the candidate files with their outlines, and the rules for choosing and ordering 3 to 5 steps.';

export const FINISH_TRACK_DESCRIPTION =
  'Save a Track once its steps are created: "saved" returns the trackId to start it with; "not-enough" means fewer than 3 steps were Verified (those Drills stay as ordinary Workouts).';

export const LIST_DESCRIPTION = "List the Drills waiting to be solved in this repository's Kintsugi queue.";

const stamp = (version: string) => `<!-- kintsugi-version: ${version} -->`;

export const STAMP_PATTERN = /<!-- kintsugi-version: ([^ ]+) -->/;

export function skillMarkdown(version: string): string {
  return `---
name: kintsugi
description: Creates Kintsugi Drills, Katas, and Tracks, practice exercises built from this repository's code, with the kintsugi MCP tools. Use when the user asks for a drill, kata, workout, or practice exercise on some code, wants to learn, explore, or onboard onto a module, or an end-of-task rule asks for a Drill.
---

${stamp(version)}

# Creating a Kintsugi Drill

1. **Choose the target.** Use the file or symbol the user named. Otherwise pick the unit with the richest logic among the code you have been reading: algorithms, state transitions, concurrency, tricky boundaries. Glue code, configuration, and CRUD make poor Drills. Use quick: true when the user wants a short one, and for end-of-task Drills. Use kind: "kata" when the user asks for a Kata: rebuilding a missing piece rather than finding a bug.

2. **Delegate the generation.** Hand it to a subagent so this conversation stays focused on the user's work. Give it the target, whether it is quick, whether it is an end-of-task Drill (afterTask: true), its kind, and this brief: "Create a Kintsugi Drill (or Kata) with the kintsugi MCP tools prepare_drill and submit_drill, following their instructions, until the result is saved, not worth practicing, or out of submissions. Reply with only the outcome: the Workout id and title, or the reason." Without subagents, do the same steps here.

3. **Report the outcome.** For a saved Drill, give its title and tell the user to start it with \`kin train <workout-id>\`. The bug is the user's to find, so the report names only the symptom the Drill's title describes; for a Kata, the missing code is the user's to write, so the report names only its title. For any other outcome, give the reason and offer a different target.

# Building a Kintsugi Track

When the user wants to learn a module rather than practise one file, build a Track: 3 to 5 Drills, each from a different file, foundations first.

1. **Start it.** Call prepare_track with the module directory the user named, or the one their question is about.

2. **Choose and order the steps** from its candidates by its rules: the files the others build on come first. Write one line per step saying why it matters for the module.

3. **Delegate the generation.** Hand it to a subagent with the trackId, the ordered steps and their why lines, and this brief: "For each step in order, create a Kintsugi Drill with prepare_drill (passing trackId and why) and submit_drill, following their instructions. If a step can't be Verified, use another candidate in its place. Then call finish_track with the trackId and a short title naming what the module does. Reply with only the outcome." Without subagents, do the same steps here.

4. **Report the outcome.** For a saved Track, give its title and steps, and tell the user to start it with \`kin track <track-id>\`. For "not-enough", say how many steps were Verified and that those Drills can still be trained with \`kin train\`.

When the user asks for help with a Drill or Kata they are solving, coach: one hint or guiding question at a time, so they find the fix or write the code themselves.
`;
}

export function commandMarkdown(version: string): string {
  return `---
description: Create a Kintsugi Drill (or Kata) from a file or symbol
argument-hint: "[path[#symbol]] [quick] [kata]"
---

${stamp(version)}

Use the kintsugi skill to create a Drill for: $ARGUMENTS
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
