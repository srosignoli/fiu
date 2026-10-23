/**
 * Everything Kintsugi tells a coding agent. The rules for using the tools live once, in the MCP
 * server instructions (every MCP client receives them); the skill carries only the workflow.
 */

export const SERVER_INSTRUCTIONS = `Kintsugi turns code in this repository into Drills: small debugging exercises the user solves by hand. Each Drill is Verified (its tests are run in a sandbox) before it is saved.

To create a Drill:
1. Call prepare_drill with a file path, optionally \`path#symbol\` to pin a function or class. Pass quick: true for a Drill that fits a short wait.
2. Write the Drill by following the returned instructions against the numbered source.
3. Call submit_drill with the generationId and the Drill. Kintsugi runs the tests itself.
4. If the result is "rejected", fix every problem in the feedback and submit again. The Drill is done when the result is "saved" or "not-worth-practicing"; when no submissions are left, tell the user it could not be Verified.

Drills under .kintsugi/ are the user's practice material: leave their files for the user to solve. When the user asks for help with a Drill, give a hint or a guiding question and let them find the fix.`;

export const PREPARE_DESCRIPTION =
  'Start a Drill from a source file in this repository. Returns a generationId, the rules for writing the Drill, the numbered source, and the schema submit_drill expects.';

export const SUBMIT_DESCRIPTION =
  'Submit a Drill written for a generationId. Kintsugi checks it and runs its tests in a sandbox: "saved" returns the Workout id; "rejected" returns feedback to fix before resubmitting; "not-worth-practicing" ends the generation.';

export const LIST_DESCRIPTION = "List the Drills waiting to be solved in this repository's Kintsugi queue.";

const stamp = (version: string) => `<!-- kintsugi-version: ${version} -->`;

export const STAMP_PATTERN = /<!-- kintsugi-version: ([^ ]+) -->/;

export function skillMarkdown(version: string): string {
  return `---
name: kintsugi
description: Creates Kintsugi Drills, debugging exercises built from this repository's code, with the kintsugi MCP tools. Use when the user asks for a drill, workout, or practice exercise on some code, or an end-of-task rule asks for one.
---

${stamp(version)}

# Creating a Kintsugi Drill

1. **Choose the target.** Use the file or symbol the user named. Otherwise pick the unit with the richest logic among the code you have been reading: algorithms, state transitions, concurrency, tricky boundaries. Glue code, configuration, and CRUD make poor Drills. Use quick: true when the user wants a short one, and for end-of-task Drills.

2. **Delegate the generation.** Hand it to a subagent so this conversation stays focused on the user's work. Give it the target, whether it is quick, whether it is an end-of-task Drill (afterTask: true), and this brief: "Create a Kintsugi Drill with the kintsugi MCP tools prepare_drill and submit_drill, following their instructions, until the result is saved, not worth practicing, or out of submissions. Reply with only the outcome: the Workout id and title, or the reason." Without subagents, do the same steps here.

3. **Report the outcome.** For a saved Drill, give its title and tell the user to start it with \`kin train <workout-id>\`. The bug is the user's to find, so the report names only the symptom the Drill's title describes. For any other outcome, give the reason and offer a different target.

When the user asks for help with a Drill they are solving, coach: one hint or guiding question at a time, so they find the fix themselves.
`;
}

export function commandMarkdown(version: string): string {
  return `---
description: Create a Kintsugi Drill from a file or symbol
argument-hint: "[path[#symbol]] [quick]"
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
