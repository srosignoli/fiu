import { homedir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DrillTargetError } from '../commands/drill.ts';
import { ConfigError } from '../config.ts';
import { UnsupportedLanguageError } from '../languages/registry.ts';
import { ToolchainMissingError } from '../languages/run.ts';
import { SandboxUnavailableError } from '../sandbox/sandbox.ts';
import { AnyWorkoutOutputSchema, PredictionSeriesOutputSchema } from '../synthesis/schema.ts';
import { SourceTooLargeError } from '../synthesis/synthesize.ts';
import { NotAGitRepositoryError } from '../workspace.ts';
import { AgentDrills, AgentRequestError } from './drills.ts';
import { compareVersions, installedVersion } from './install.ts';
import { FIND_RULE_DESCRIPTION, FINISH_TRACK_DESCRIPTION, LIST_DESCRIPTION, PREPARE_ATLAS_DESCRIPTION, SEARCH_ATLAS_DESCRIPTION, SUBMIT_ATLAS_DESCRIPTION, PREPARE_DESCRIPTION, PREPARE_TRACK_DESCRIPTION, SERVER_INSTRUCTIONS, SUBMIT_DESCRIPTION } from './texts.ts';
import { ExploreTargetError } from '../explore/shortlist.ts';
import { AtlasOutputSchema } from '../atlas/describe.ts';
import { AtlasTargetError } from '../atlas/skeleton.ts';

/** Errors the agent can act on (wrong target, no sandbox, full queue…), returned as tool errors rather than crashes. */
const AGENT_FACING_ERRORS = [
  AgentRequestError,
  DrillTargetError,
  ConfigError,
  UnsupportedLanguageError,
  SandboxUnavailableError,
  SourceTooLargeError,
  NotAGitRepositoryError,
  ToolchainMissingError,
  ExploreTargetError,
  AtlasTargetError,
];

export interface KinMcpServerOptions {
  version: string;
  home?: string;
}

/** `fiu mcp`: Fiu's tools for the user's coding agent. */
export function createMcpServer(drills: AgentDrills, { version, home = homedir() }: KinMcpServerOptions): McpServer {
  const server = new McpServer({ name: 'fiu', version }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    'prepare_drill',
    {
      title: 'Prepare a Fiu Drill, Kata, Prediction, or Diagnosis',
      description: PREPARE_DESCRIPTION,
      inputSchema: {
        target: z.string().describe('A source file in this repository, relative to its root, optionally followed by #symbol.'),
        kind: z
          .enum(['drill', 'kata', 'prediction', 'diagnosis'])
          .optional()
          .describe('"drill" (find the bug, the default), "kata" (rebuild a removed piece from a brief), "prediction" (predict what the code does in a plain-English Scenario), or "diagnosis" (choose which Cause explains a practice incident); the last two are for people who don\'t read code.'),
        quick: z.boolean().optional().describe('A Quick Drill or Kata: small enough for a short wait. Every Prediction and Diagnosis is Quick.'),
        afterTask: z.boolean().optional().describe('True only when generating at the end of your own coding task.'),
        trackId: z.string().optional().describe('Makes this Drill the next step of a Track started with prepare_track.'),
        why: z.string().optional().describe('For a Track step: one line on why this file matters for the module.'),
        whatIf: z.string().optional().describe('Predictions only: a What-if, asking what the code would do with a change nobody has made. The change in the user\'s words, or an empty string to propose one yourself.'),
        questions: z.number().optional().describe('Predictions only: ask a Series of this many questions (2 to 5) about the unit, from one shared extraction. The user asks for 3 unless they say otherwise.'),
        rule: z.string().optional().describe('Predictions only: a business rule to ask about, its text as find_rule returns it (or the user\'s own sentence, 4 words or more). The Prediction measures whether the code follows it.'),
      },
    },
    ({ target, kind, quick, afterTask, trackId, why, questions, whatIf, rule }) =>
      respond(async () => {
        const prepared = await drills.prepare({ target, kind, quick, origin: afterTask ? 'agent-task' : 'manual', trackId, why, questions, whatIf, rule });
        const notice = await staleInstallNotice(home, prepared.repository, version);
        return { ...prepared, ...(notice ? { notice } : {}) };
      }),
  );

  server.registerTool(
    'submit_drill',
    {
      title: 'Submit a Fiu Drill, Kata, Prediction, or Diagnosis',
      description: SUBMIT_DESCRIPTION,
      // A Series (prepared with questions) has its own shape: the shared unit, then the questions.
      inputSchema: { generationId: z.string(), workout: z.union([AnyWorkoutOutputSchema, PredictionSeriesOutputSchema]) },
    },
    ({ generationId, workout }) =>
      respond(async () => {
        const result = await drills.submit(generationId, workout);
        return result.status === 'saved' ? { ...result, next: `The user starts it with: fiu train ${result.workoutId}${result.series ? ' (the runner offers the next question after each answer)' : ''}` } : result;
      }),
  );

  server.registerTool(
    'prepare_track',
    {
      title: 'Prepare a Fiu Track',
      description: PREPARE_TRACK_DESCRIPTION,
      inputSchema: {
        module: z.string().optional().describe('A module directory in this repository, relative to its root.'),
        flow: z.string().optional().describe("Instead of a module: the name of a business flow from Understand-Anything's domain graph to follow, step by step."),
      },
    },
    ({ module, flow }) => respond(() => drills.prepareTrack(module, flow)),
  );

  server.registerTool(
    'find_rule',
    {
      title: 'Find a business rule',
      description: FIND_RULE_DESCRIPTION,
      inputSchema: { words: z.string().optional().describe('Words of the rule; leave out to list every rule.') },
    },
    ({ words }) => respond(() => drills.findRules(words)),
  );

  server.registerTool(
    'finish_track',
    {
      title: 'Finish a Fiu Track',
      description: FINISH_TRACK_DESCRIPTION,
      inputSchema: { trackId: z.string(), title: z.string().describe('A short title naming what the module does.') },
    },
    ({ trackId, title }) => respond(() => drills.finishTrack(trackId, title)),
  );

  server.registerTool(
    'prepare_atlas',
    {
      title: 'Prepare the next folder of the Fiu Atlas',
      description: PREPARE_ATLAS_DESCRIPTION,
      inputSchema: { dir: z.string().optional().describe('A folder in this repository, relative to its root; the whole repository when left out.') },
    },
    ({ dir }) => respond(() => drills.prepareAtlas(dir)),
  );

  server.registerTool(
    'submit_atlas',
    {
      title: 'Submit Fiu Atlas entries for a folder',
      description: SUBMIT_ATLAS_DESCRIPTION,
      inputSchema: {
        folder: z.string().describe('The folder prepare_atlas returned ("" for the repository root).'),
        entries: AtlasOutputSchema,
        scope: z.string().optional().describe('The folder you are building the Atlas for (as passed to prepare_atlas), so the result lists what remains of it.'),
      },
    },
    ({ folder, entries, scope }) => respond(() => drills.submitAtlas(folder, entries, scope)),
  );

  server.registerTool(
    'search_atlas',
    {
      title: 'Search the Fiu Atlas',
      description: SEARCH_ATLAS_DESCRIPTION,
      inputSchema: { goal: z.string().describe('What the user wants to learn, in their words.') },
    },
    ({ goal }) => respond(() => drills.searchAtlas(goal)),
  );

  server.registerTool('list_workouts', { title: 'List Fiu Workouts', description: LIST_DESCRIPTION }, () =>
    respond(async () => ({ repository: await drills.repository(), workouts: await drills.list() })),
  );

  return server;
}

async function respond(work: () => Promise<unknown>) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await work(), null, 2) }] };
  } catch (error) {
    if (!AGENT_FACING_ERRORS.some((type) => error instanceof type)) throw error;
    return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] };
  }
}

async function staleInstallNotice(home: string, repoRoot: string, version: string): Promise<string | undefined> {
  const installed = await installedVersion(home, repoRoot);
  if (!installed || compareVersions(installed, version) >= 0) return undefined;
  return `The Fiu skill installed for this agent is from version ${installed}; Fiu is now ${version}. Tell the user to run \`fiu agent install claude\` again.`;
}
