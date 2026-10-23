import { homedir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DrillTargetError } from '../commands/drill.ts';
import { ConfigError } from '../config.ts';
import { UnsupportedLanguageError } from '../languages/registry.ts';
import { ToolchainMissingError } from '../languages/run.ts';
import { SandboxUnavailableError } from '../sandbox/sandbox.ts';
import { DrillOutputSchema } from '../synthesis/schema.ts';
import { SourceTooLargeError } from '../synthesis/synthesize.ts';
import { NotAGitRepositoryError } from '../workspace.ts';
import { AgentDrills, AgentRequestError } from './drills.ts';
import { compareVersions, installedVersion } from './install.ts';
import { LIST_DESCRIPTION, PREPARE_DESCRIPTION, SERVER_INSTRUCTIONS, SUBMIT_DESCRIPTION } from './texts.ts';

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
];

export interface KinMcpServerOptions {
  version: string;
  home?: string;
}

/** `kin mcp`: Kintsugi's tools for the user's coding agent. */
export function createMcpServer(drills: AgentDrills, { version, home = homedir() }: KinMcpServerOptions): McpServer {
  const server = new McpServer({ name: 'kintsugi', version }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    'prepare_drill',
    {
      title: 'Prepare a Kintsugi Drill',
      description: PREPARE_DESCRIPTION,
      inputSchema: {
        target: z.string().describe('A source file in this repository, relative to its root, optionally followed by #symbol.'),
        quick: z.boolean().optional().describe('A Quick Drill: small enough for a short wait.'),
        afterTask: z.boolean().optional().describe('True only when generating at the end of your own coding task.'),
      },
    },
    ({ target, quick, afterTask }) =>
      respond(async () => {
        const prepared = await drills.prepare({ target, quick, origin: afterTask ? 'agent-task' : 'manual' });
        const notice = await staleInstallNotice(home, prepared.repository, version);
        return { ...prepared, ...(notice ? { notice } : {}) };
      }),
  );

  server.registerTool(
    'submit_drill',
    {
      title: 'Submit a Kintsugi Drill',
      description: SUBMIT_DESCRIPTION,
      inputSchema: { generationId: z.string(), workout: DrillOutputSchema },
    },
    ({ generationId, workout }) =>
      respond(async () => {
        const result = await drills.submit(generationId, workout);
        return result.status === 'saved' ? { ...result, next: `The user starts it with: kin train ${result.workoutId}` } : result;
      }),
  );

  server.registerTool('list_workouts', { title: 'List Kintsugi Workouts', description: LIST_DESCRIPTION }, () =>
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
  return `The Kintsugi skill installed for this agent is from version ${installed}; Kintsugi is now ${version}. Tell the user to run \`kin agent install claude\` again.`;
}
