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
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths } from './workspace.ts';
import { loadRepoConfig, loadUserConfig, resolveConfig } from './config.ts';

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
    console.log('To get a Quick Drill from each of your commits in the background, run: kin auto on');
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

function pausedMessage(queued: number, cap: number): string {
  return `Paused: the queue is full (${queued} of ${cap} Workouts waiting), so new commits won't get Drills until you attempt or \`kin discard\` one (or raise the cap with \`kin auto on --queue-cap <n>\`).`;
}

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
      ...(report.trackPlanning.count > 0 ? [row('Planning Tracks', report.trackPlanning)] : []),
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
  .command('explore')
  .description('Build a Track for a module: 3 to 5 Drills, each from a different file, foundations first.')
  .argument('<path>', 'the module directory')
  .option('-y, --yes', 'consent to sending code and to the estimated cost without prompting', false)
  .option('--no-sandbox', 'run Workout code without isolation, for this invocation only')
  .option('--no-train', 'only build the Track, without opening its first step')
  .action(async (path: string, options: { yes: boolean; sandbox: boolean; train: boolean }) => {
    const { explore } = await import('./commands/explore.ts');
    const ui = terminalUi();
    let result;
    try {
      result = await explore(process.cwd(), path, options, ui);
    } finally {
      ui.settle();
    }
    if (result.status === 'plan-failed') {
      log.error(`Couldn't choose the Track's steps:\n${result.problems.map((p) => `- ${p}`).join('\n')}`);
      process.exitCode = 1;
      return;
    }
    if (result.status === 'declined') {
      log.info('No Drills generated. (Choosing the steps was a single small call, already recorded in `kin cost`.)');
      return;
    }
    for (const drop of result.dropped) log.warn(`Dropped ${drop}`);
    if (result.status === 'not-enough') {
      log.error(`Only ${result.workoutIds.length} step(s) could be Verified, too few for a Track. They're kept as ordinary Workouts: ${result.workoutIds.join(', ') || 'none'}.`);
      process.exitCode = 1;
      return;
    }
    log.success(`Saved the Track "${result.track.title}" (${result.track.id}) with ${result.track.steps.length} steps.`);
    if (options.train && process.stdin.isTTY) await runTrack(result.track.id, options);
    else log.info(`Start it with: kin track ${result.track.id}`);
  });

program
  .command('track')
  .description("List your Tracks, or continue one: shows its progress and opens the next step.")
  .argument('[track-id]', 'the Track to continue')
  .option('--no-sandbox', 'run the tests without isolation, for this invocation only')
  .action(async (id: string | undefined, options: { sandbox: boolean }) => {
    const { trackListing } = await import('./commands/track.ts');
    if (!id) {
      const listing = await trackListing(process.cwd());
      if (listing.length === 0) {
        log.info('No Tracks yet. Build one with: kin explore <module-directory>');
        return;
      }
      if (listing.length > 1) {
        log.message(listing.map(({ track, done, total }) => `${track.id}  ${done}/${total}  ${track.title}`).join('\n'));
        log.info('Continue one with: kin track <track-id>');
        return;
      }
      id = listing[0]!.track.id;
    }
    await runTrack(id, options);
  });

async function runTrack(id: string, options: { sandbox: boolean }): Promise<void> {
  const { continueTrack } = await import('./commands/track.ts');
  const io = terminalTrainIo();
  let result;
  try {
    result = await continueTrack(process.cwd(), id, options, io);
  } finally {
    io.close();
  }
  if (result.status === 'track-complete') log.success('Every step of this Track has been attempted. Redo any step with: kin train <workout-id>');
  else if (result.status === 'completed' || result.status === 'abandoned') log.info(`Next step: kin track ${id}`);
}

program
  .command('quick')
  .description('Start the best Quick Workout in the queue right away: for a short wait.')
  .option('--no-sandbox', 'run the tests without isolation, for this invocation only')
  .action(async (options: { sandbox: boolean }) => {
    await failureSummary();
    const io = terminalTrainIo();
    let result;
    try {
      result = await quick(process.cwd(), options, io);
    } finally {
      io.close();
    }
    if (result.status === 'nothing-ready') {
      const generate = await confirm({ message: 'No Quick Workout is ready. Generate one from your latest commit now?', initialValue: false });
      if (generate === true) {
        await runRefill({ background: false, sandbox: options.sandbox, train: true });
      } else {
        log.info('Make one with `kin drill --quick <file>`, or ask your agent: `/kin-drill <file> quick`.');
      }
    } else if (result.status === 'completed' || result.status === 'abandoned') {
      log.info(`Attempt ${result.attempt} kept at ${result.dir}.`);
    }
  });

program
  .command('refill')
  .description('Generate a Quick Drill from a commit (the latest by default). The git hook runs this in the background.')
  .option('--commit <sha>', 'the commit to generate from (default: HEAD)')
  .option('--background', 'run unattended, as the hook does: never prompts, needs `kin auto on`, obeys the caps')
  .option('-y, --yes', 'consent to sending code to the configured provider without prompting', false)
  .option('--no-sandbox', 'run Workout code without isolation, for this invocation only (never in the background)')
  .option('--no-train', 'only save the Drill, without opening the runner')
  .action(async (options: { commit?: string; background?: boolean; yes: boolean; sandbox: boolean; train: boolean }) => {
    await runRefill({ ...options, background: options.background ?? false });
  });

const auto = program.command('auto').description('Background generation: a Quick Drill from each of your commits.');

auto
  .command('on')
  .description('Turn background generation on for this repository and install the git hook.')
  .option('-y, --yes', 'consent without prompting', false)
  .option('--queue-cap <count>', 'at most this many Workouts waiting in the queue (default 3)')
  .option('--daily-limit <count>', 'at most this many generations a day, retries included (default 5)')
  .option('--ai-only', 'only generate from AI-authored commits')
  .action(async (options: { yes: boolean; queueCap?: string; dailyLimit?: string; aiOnly?: boolean }) => {
    const { enableAuto } = await import('./background/auto.ts');
    const paths = workspacePaths(await findRepoRoot(process.cwd()));
    await ensureWorkspace(paths);
    await excludeWorkspaceFromGit(paths.repoRoot);
    const repoConfig = await loadRepoConfig(paths.configFile);
    const config = resolveConfig(repoConfig, await loadUserConfig());
    const positive = (value: string | undefined, flag: string) => {
      if (value === undefined) return undefined;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a whole number of at least 1, not "${value}".`);
      return n;
    };
    const caps = {
      ...(options.queueCap ? { queueCap: positive(options.queueCap, '--queue-cap') } : {}),
      ...(options.dailyLimit ? { dailyLimit: positive(options.dailyLimit, '--daily-limit') } : {}),
      ...(options.aiOnly ? { aiOnly: true } : {}),
    };
    const hook = await enableAuto({
      paths,
      repoConfig,
      provider: config.provider,
      model: config.model,
      kinCommand: kinCommand(),
      caps,
      yes: options.yes,
      confirm: process.stdin.isTTY ? async (message) => (await confirm({ message, initialValue: false })) === true : undefined,
    });
    if (!hook) {
      log.info('Background generation stays off.');
      return;
    }
    if (hook.status === 'installed') log.success(`Background generation is on. Hook: ${hook.path}`);
    else log.warn(`Background generation is on, but core.hooksPath is set (${hook.hooksPath}). Add this to your post-commit hook:\n${hook.snippet}`);
    const { autoStatus } = await import('./background/auto.ts');
    const status = await autoStatus(paths, await loadRepoConfig(paths.configFile));
    if (status.paused) log.warn(pausedMessage(status.queued, status.caps.queueCap));
    log.info('Tip: keep your API key in the user config: commits made from GUI tools may not see shell variables.');
  });

auto
  .command('off')
  .description('Turn background generation off and remove the git hook block.')
  .action(async () => {
    const { removeHook, setAuto } = await import('./background/auto.ts');
    const paths = workspacePaths(await findRepoRoot(process.cwd()));
    await setAuto(paths.configFile, false);
    const { removed, path } = await removeHook(paths.repoRoot);
    log.success(`Background generation is off.${removed ? ` Removed Kintsugi's block from ${path}.` : ''}`);
  });

auto
  .command('status')
  .description('Show whether background generation is on, today’s usage, the queue, and recent failures.')
  .action(async () => {
    const { autoStatus } = await import('./background/auto.ts');
    const paths = workspacePaths(await findRepoRoot(process.cwd()));
    const s = await autoStatus(paths, await loadRepoConfig(paths.configFile));
    const lines = [
      `Background generation: ${s.enabled ? 'on' : 'off'}${s.enabled && !s.hookInstalled ? ' (no hook in .git/hooks: add it to your hook manager, or run kin auto on again)' : ''}`,
      `Today: ${s.generationsToday} of ${s.caps.dailyLimit} generations used`,
      `Queue: ${s.queued} of ${s.caps.queueCap} Workouts waiting${s.backlog ? `; ${s.backlog} commit(s) in the backlog` : ''}`,
      ...(s.enabled && s.paused ? [pausedMessage(s.queued, s.caps.queueCap)] : []),
      ...(s.caps.aiOnly ? ['Only AI-authored commits'] : []),
      ...s.recentFailures.map((f) => `Failed ${f.at.slice(0, 16).replace('T', ' ')}: ${f.commit?.slice(0, 12) ?? ''} ${f.reason ?? ''}`),
    ];
    log.message(lines.join('\n'));
  });

program
  .command('log')
  .description('Show what background generation did: Drills generated, commits skipped, and failures.')
  .option('-n, --limit <count>', 'how many entries to show', '20')
  .action(async (options: { limit: string }) => {
    const { readLog } = await import('./background/log.ts');
    const entries = (await readLog(workspacePaths(await findRepoRoot(process.cwd())))).slice(-Number(options.limit));
    if (entries.length === 0) log.info('Nothing logged yet.');
    for (const e of entries) {
      const what = [e.commit?.slice(0, 12), e.source, e.workoutId, e.reason].filter(Boolean).join('  ');
      log.message(`${e.at.slice(0, 19).replace('T', ' ')}  ${e.background ? 'background' : 'manual    '}  ${e.outcome.padEnd(20)}  ${what}`);
    }
  });

async function runRefill(options: { commit?: string; background: boolean; yes?: boolean; sandbox: boolean; train: boolean }): Promise<void> {
  const { refill } = await import('./background/refill.ts');
  if (options.background) {
    // Unattended: say nothing, decide nothing; everything goes to .kintsugi/log.
    await refill(process.cwd(), options, { step: () => {}, warn: () => {} });
    return;
  }
  const ui = terminalUi();
  let saved: string | undefined;
  try {
    const { outcomes } = await refill(process.cwd(), options, ui);
    ui.settle();
    for (const outcome of outcomes) {
      const commit = outcome.commit?.slice(0, 12) ?? '';
      if (outcome.outcome === 'generated') {
        saved = outcome.workoutId;
        log.success(`Saved a Quick Drill from ${commit} (${outcome.source}): ${outcome.workoutId}`);
      } else {
        log.warn(`${commit}: ${outcome.outcome}${outcome.reason ? ` (${outcome.reason})` : ''}`);
      }
    }
  } finally {
    ui.settle();
  }
  if (saved && options.train && process.stdin.isTTY) await runTrain(saved, { sandbox: options.sandbox });
}

/** One line about background failures not yet shown. */
async function failureSummary(): Promise<void> {
  try {
    const { unseenFailureSummary } = await import('./background/log.ts');
    const summary = await unseenFailureSummary(workspacePaths(await findRepoRoot(process.cwd())));
    if (summary) log.warn(summary);
  } catch {
    // Outside a repository, or no workspace yet: nothing to report.
  }
}

program
  .command('train')
  .description('Work on a pending Workout: its tests re-run in the sandbox on every save.')
  .argument('[workout-id]', 'the Workout to train on (a picker opens when omitted)')
  .option('--no-sandbox', 'run the tests without isolation, for this invocation only')
  .action(async (id: string | undefined, options: { sandbox: boolean }) => {
    await failureSummary();
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
