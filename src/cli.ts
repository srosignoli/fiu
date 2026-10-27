#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { confirm, log, spinner } from '@clack/prompts';
import { Command } from 'commander';
import { costReport, startOfMonth, type SpendBucket } from './commands/cost.ts';
import { drill, type DrillUi } from './commands/drill.ts';
import { describeCost, formatUsd, totalTokens } from './cost/usage.ts';
import { EDITOR_TIP, init } from './commands/init.ts';
import { quick, train, type TrainResult } from './commands/train.ts';
import { terminalTrainIo } from './terminal.ts';
import { VERSION } from './version.ts';
import { discardWorkout, legacyDoneNotice, restoreWorkout } from './workouts/store.ts';
import { findRepoRoot, workspacePaths } from './workspace.ts';

const program = new Command()
  .name('kintsugi')
  .description('Turn real code from your repository into small, verified practice Workouts.')
  .version(VERSION);

program
  .command('init')
  .description('Set up the .kintsugi/ workspace in the current git repository.')
  .action(async () => {
    const { paths, createdWorkspace, updatedGitExclude, sandboxProblem } = await init(process.cwd());
    console.log(createdWorkspace ? `Created ${paths.root}` : `Workspace already exists at ${paths.root}`);
    if (updatedGitExclude) console.log('Hid .kintsugi/ from git via .git/info/exclude');
    if (sandboxProblem) {
      console.error(sandboxProblem.message);
      process.exitCode = 1;
    } else {
      console.log('Sandbox check passed.');
    }
    console.log(EDITOR_TIP);
  });

program
  .command('drill')
  .description('Generate a Drill from a file (optionally pinned to a symbol), verify it, and save it.')
  .argument('<target>', 'the source file, optionally followed by #symbol')
  .option('--quick', 'a Quick Drill, small enough for a short wait')
  .option('--no-train', 'only save the Drill, without opening the runner')
  .option('-y, --yes', 'consent to sending code to the configured provider without prompting', false)
  .option('--no-sandbox', 'run Workout code without isolation, for this invocation only')
  .action(async (target: string, options: { train: boolean; yes: boolean; sandbox: boolean; quick?: boolean }) => {
    const ui = terminalUi();
    try {
      const result = await drill(process.cwd(), target, options, ui);
      ui.settle();
      if (result.status === 'not-worth-practicing') {
        log.warn(`Nothing worth drilling in ${target} (${describeCost(result.cost)} spent): ${result.reason}`);
      } else if (result.status === 'failed') {
        log.error(
          `Couldn't produce a Verified Workout from ${target} (${describeCost(result.cost)} spent). The last attempt failed with:\n${result.feedback}`,
        );
        process.exitCode = 1;
      } else {
        const { record, workoutDir } = result;
        log.success(`Saved Drill "${record.title}" (${record.id}), generated for ${describeCost(result.cost)}`);
        if (options.train && process.stdin.isTTY) {
          ui.settle();
          await runTrain(record.id, options);
        } else {
          log.message(
            [
              `Read the incident report: ${join(workoutDir, 'README.md')}`,
              `Fix the bug in:           ${join(workoutDir, record.files.code)}`,
              `Then train with:          kin train ${record.id}`,
            ].join('\n'),
          );
        }
      }
    } finally {
      ui.settle();
    }
  });

program
  .command('mcp')
  .description("Run Kintsugi's MCP server (stdio), so your coding agent can create Drills. Started by the agent, not by hand.")
  .action(async () => {
    // Loaded lazily: only the agent's server process needs the MCP SDK.
    const { AgentDrills } = await import('./agent/drills.ts');
    const { createMcpServer } = await import('./agent/mcp.ts');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const drills = new AgentDrills({ cwd: process.cwd() });
    const server = createMcpServer(drills, { version: VERSION });
    // stdout carries the protocol: nothing else may write to it.
    server.server.onclose = () => void drills.close();
    await server.connect(new StdioServerTransport());
  });

const agent = program.command('agent').description('Set up your coding agent to create Drills with Kintsugi.');

agent
  .command('install')
  .argument('<agent>', 'the coding agent: claude (Claude Code)')
  .description("Install Kintsugi's skill, /kin-drill command, and MCP server for your coding agent.")
  .option('--project', 'install into this repository only (untracked) instead of for your user')
  .option('--after-tasks', 'also ask the agent to create a Quick Drill when it finishes a coding task')
  .action(async (name: string, options: { project?: boolean; afterTasks?: boolean }) => {
    const { installClaude } = await import('./agent/install.ts');
    assertClaude(name);
    const report = await installClaude({
      scope: options.project ? 'project' : 'user',
      afterTasks: options.afterTasks ?? false,
      version: VERSION,
      home: homedir(),
      cwd: process.cwd(),
      kinCommand: kinCommand(),
    });
    for (const path of report.written) log.step(`Wrote ${path}`);
    for (const path of report.removed) log.step(`Removed ${path}`);
    if (report.manualMcpCommand) {
      log.warn(`Couldn't register the MCP server with the claude CLI. Run this yourself:\n${report.manualMcpCommand}`);
    } else {
      log.step('Registered the kintsugi MCP server with Claude Code');
    }
    log.success('Done. In Claude Code, ask for a drill (or type /kin-drill <file>), then start it with kin train.');
  });

agent
  .command('uninstall')
  .argument('<agent>', 'the coding agent: claude (Claude Code)')
  .description('Remove what `kin agent install` added.')
  .option('--project', 'remove the installation from this repository')
  .action(async (name: string, options: { project?: boolean }) => {
    const { uninstallClaude } = await import('./agent/install.ts');
    assertClaude(name);
    const report = await uninstallClaude({ scope: options.project ? 'project' : 'user', home: homedir(), cwd: process.cwd() });
    for (const path of report.removed) log.step(`Removed ${path}`);
    if (report.manualMcpCommand) log.warn(`The claude CLI isn't available. Run this yourself:\n${report.manualMcpCommand}`);
    log.success('Done.');
  });

function assertClaude(name: string): void {
  if (name !== 'claude') {
    throw new Error(`Only "claude" (Claude Code) has an installer so far. Other MCP clients can run \`${kinCommand().join(' ')} mcp\` as a stdio server.`);
  }
}

/** How to start this same `kin` again, independent of the PATH the agent sees. */
function kinCommand(): string[] {
  return [process.execPath, ...process.execArgv, realpathSync(process.argv[1]!)];
}

program
  .command('cost')
  .description('Show what generating Workouts has cost, and how much of it is still unused.')
  .option('--since <date>', 'start of the period, e.g. 2026-10-01 (default: the start of this month)')
  .action(async (options: { since?: string }) => {
    const since = options.since ? new Date(`${options.since}T00:00:00`) : startOfMonth();
    if (Number.isNaN(since.getTime())) throw new Error(`--since must be a date like 2026-10-01, not "${options.since}".`);
    const report = await costReport(process.cwd(), since);
    const row = (label: string, bucket: SpendBucket, note = '') =>
      `  ${label.padEnd(24)} ≈ ${formatUsd(bucket.usd).padStart(8)}  (${bucket.count})${note}`;
    const lines = [
      `Since ${localDate(since)}: ≈ ${formatUsd(report.total.usd)} on ${report.total.count} generation request(s)`,
      row('Workouts attempted', report.attempted),
      row('Never attempted', report.neverAttempted, report.neverAttempted.count > 0 ? '   paid for, not used yet' : ''),
      row('Produced nothing', report.producedNothing),
    ];
    if (Object.keys(report.byOrigin).length > 1) {
      for (const [origin, bucket] of Object.entries(report.byOrigin)) lines.push(row(`From ${origin}`, bucket));
    }
    if (report.byAgent.requests > 0) {
      lines.push(
        `  Generated by your agent: ${report.byAgent.workouts} Workout(s) from ${report.byAgent.requests} request(s) (cost not measured: it used your agent's plan)`,
      );
    }
    for (const usage of report.unpriced) {
      const tokens = totalTokens({ usage: [usage], usd: 0, unpricedModels: [], pricesAsOf: '' });
      lines.push(`  Not priced: ${tokens.toLocaleString('en-US')} tokens from ${usage.model} (add it under "prices" in config)`);
    }
    lines.push(`Estimates use list prices as of ${report.pricesAsOf}; your provider's bill is authoritative.`);
    log.message(lines.join('\n'));
    await legacyNotice();
  });

program
  .command('quick')
  .description('Start the best Quick Workout in the queue right away: for a short wait.')
  .option('--no-sandbox', 'run the tests without isolation, for this invocation only')
  .action(async (options: { sandbox: boolean }) => {
    const io = terminalTrainIo();
    let result;
    try {
      result = await quick(process.cwd(), options, io);
    } finally {
      io.close();
    }
    if (result.status === 'nothing-ready') {
      log.info('No Quick Workout is ready. Make one with `kin drill --quick <file>`, or ask your agent: `/kin-drill <file> quick`.');
    } else if (result.status === 'completed' || result.status === 'abandoned') {
      log.info(`Attempt ${result.attempt} kept at ${result.dir}.`);
    }
  });

program
  .command('train')
  .description('Work on a pending Workout: its tests re-run in the sandbox on every save.')
  .argument('[workout-id]', 'the Workout to train on (a picker opens when omitted)')
  .option('--no-sandbox', 'run the tests without isolation, for this invocation only')
  .action(async (id: string | undefined, options: { sandbox: boolean }) => {
    await runTrain(id, options);
  });

async function runTrain(id: string | undefined, options: { sandbox: boolean }): Promise<void> {
  const io = terminalTrainIo();
  let result: TrainResult;
  try {
    result = await train(process.cwd(), id, options, io);
  } finally {
    io.close();
  }
  if (result.status === 'nothing-pending') log.info('No Workouts waiting. Create one with: kin drill <file>');
  else if (result.status === 'completed' || result.status === 'abandoned') {
    log.info(`Attempt ${result.attempt} kept at ${result.dir}. Redo it any time with: kin train ${result.workoutId}`);
  }
  await legacyNotice();
}

/** One line about v1's done/ folder, which v2 no longer reads. */
async function legacyNotice(): Promise<void> {
  try {
    const notice = legacyDoneNotice(workspacePaths(await findRepoRoot(process.cwd())));
    if (notice) log.info(notice);
  } catch {
    // Outside a repository there is nothing to say.
  }
}

program
  .command('discard')
  .argument('<workout-id>', 'the Workout to archive')
  .description('Archive a Workout: hidden from the queue, but kept. Undo with kin restore.')
  .action(async (id: string) => {
    await discardWorkout(workspacePaths(await findRepoRoot(process.cwd())), id, 'manual');
    log.success(`Discarded ${id}. Bring it back with: kin restore ${id}`);
  });

program
  .command('restore')
  .argument('<workout-id>', 'the Discarded Workout to bring back')
  .description('Bring a Discarded Workout back.')
  .action(async (id: string) => {
    await restoreWorkout(workspacePaths(await findRepoRoot(process.cwd())), id);
    log.success(`Restored ${id}.`);
  });

/** YYYY-MM-DD in local time (toISOString would shift local midnight to the previous day east of UTC). */
const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Shows each step as a spinner until the next one starts. */
function terminalUi(): DrillUi & { settle(): void } {
  let current: ReturnType<typeof spinner> | undefined;
  const settle = () => {
    current?.stop();
    current = undefined;
  };
  return {
    settle,
    step(message) {
      settle();
      if (message.includes('\n')) {
        log.warn(message);
      } else {
        current = spinner();
        current.start(message);
      }
    },
    warn(message) {
      settle();
      log.warn(message);
    },
    confirm: process.stdin.isTTY
      ? async (message) => {
          settle();
          return (await confirm({ message, initialValue: false })) === true;
        }
      : undefined,
  };
}

try {
  await program.parseAsync();
} catch (error) {
  console.error(`kintsugi: ${(error as Error).message}`);
  process.exitCode = 1;
}
