#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { styleText } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { confirm, log, spinner } from '@clack/prompts';
import { Command } from 'commander';
import { costReport, startOfMonth, type SpendBucket } from './commands/cost.ts';
import { drill, type DrillUi } from './commands/drill.ts';
import { MAX_SERIES_QUESTIONS, NOUN, type WorkoutKind } from './synthesis/schema.ts';
import { describeCost, formatUsd, totalTokens } from './cost/usage.ts';
import { EDITOR_TIP, init } from './commands/init.ts';
import { quick, quickWhile, train, type TrainResult } from './commands/train.ts';
import { runInForeground } from './runner/background.ts';
import { terminalTrainIo } from './terminal.ts';
import { migrateFromFormerNames } from './legacy.ts';
import { VERSION } from './version.ts';
import { discardSeries, discardWorkout, legacyDoneNotice, restoreWorkout } from './workouts/store.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths } from './workspace.ts';
import { loadRepoConfig, loadUserConfig, resolveConfig, type PreferredKind } from './config.ts';

const program = new Command()
  .name('fiu')
  .description('A nose for code you never typed: real code from the repository, turned into small, verified practice Workouts.')
  .version(VERSION)
  // Once per machine and repository: move what the project's former names (Fiutsu, Kintsugi) left behind.
  .hook('preAction', async () => {
    try {
      const notices = await migrateFromFormerNames({ cwd: process.cwd(), configEnv: { env: process.env, home: homedir() }, fiuCommand: fiuCommand() });
      for (const notice of notices) console.error(notice);
    } catch (error) {
      console.error(`fiu: couldn't move Fiutsu's or Kintsugi's files to Fiu's names: ${(error as Error).message}`);
    }
  });

program
  .command('init')
  .description('Set up the .fiu/ workspace in the current git repository.')
  .action(async () => {
    const { paths, createdWorkspace, updatedGitExclude, sandboxProblem } = await init(process.cwd());
    console.log(createdWorkspace ? `Created ${paths.root}` : `Workspace already exists at ${paths.root}`);
    if (updatedGitExclude) console.log('Hid .fiu/ from git via .git/info/exclude');
    if (sandboxProblem) {
      console.error(sandboxProblem.message);
      process.exitCode = 1;
    } else {
      console.log('Sandbox check passed.');
    }
    console.log(EDITOR_TIP);
    console.log('To get a Quick Drill from each of your commits in the background, run: fiu auto on');
  });

/** `fiu drill`, `fiu kata`, and `fiu predict`: the same flow, differing only in what is generated and how it is described. */
function trackKindList(value: string): WorkoutKind[] {
  const kinds = value.split(',').map((k) => k.trim()).filter(Boolean);
  const unknown = kinds.filter((k) => !(k in NOUN));
  if (kinds.length === 0 || unknown.length > 0) throw new Error(`--kinds takes drill, kata, prediction, and diagnosis, comma-separated, not "${value}".`);
  return kinds as WorkoutKind[];
}

function questionCount(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SERIES_QUESTIONS) throw new Error(`--questions must be a whole number from 1 to ${MAX_SERIES_QUESTIONS}, not "${value}".`);
  return n;
}

function generationCommand(kind: WorkoutKind) {
  const noun = NOUN[kind];
  return async (target: string | undefined, options: { train: boolean; yes: boolean; sandbox: boolean; quick?: boolean; questions?: number; whatIf?: string | true; rule?: string }) => {
    const ui = terminalUi();
    try {
      const result = await drill(process.cwd(), target, { ...options, kind }, ui);
      ui.settle();
      if (result.status === 'not-worth-practicing') {
        log.warn(`Nothing worth practising in ${target ?? 'that file'} (${describeCost(result.cost)} spent): ${result.reason}`);
      } else if (result.status === 'failed') {
        log.error(
          `Couldn't produce a Verified Workout from ${target ?? 'that file'} (${describeCost(result.cost)} spent). The last attempt failed with:\n${result.feedback}`,
        );
        process.exitCode = 1;
      } else {
        const { record, workoutDir, series } = result;
        if (series) {
          const short = series.records.length < series.requested ? ` (${series.requested - series.records.length} couldn't be Verified)` : '';
          log.success(
            [`Saved a Series of ${series.records.length} Predictions${short}, generated for ${describeCost(result.cost)}:`, ...series.records.map((r, i) => `  ${i + 1}. ${r.title} (${r.id})`)].join('\n'),
          );
        } else {
          log.success(`Saved ${noun} "${record.title}" (${record.id}), generated for ${describeCost(result.cost)}`);
        }
        if (options.train && process.stdin.isTTY) {
          ui.settle();
          await runTrain(record.id, options);
        } else {
          log.message(
            (kind === 'drill'
              ? [`Read the incident report: ${join(workoutDir, 'README.md')}`, `Fix the bug in:           ${join(workoutDir, record.files.code)}`]
              : kind === 'kata'
                ? [`Read the brief:           ${join(workoutDir, 'README.md')}`, `Fill in the gap in:       ${join(workoutDir, record.files.code)}`]
                : kind === 'diagnosis'
                  ? [`Read the incident:        ${join(workoutDir, 'README.md')}`]
                  : [`Read the Scenario:        ${join(workoutDir, 'README.md')}`]
            )
              .concat(`Then train with:          fiu train ${record.id}`)
              .join('\n'),
          );
        }
      }
    } finally {
      ui.settle();
    }
  };
}

program
  .command('drill')
  .description('Generate a Drill from a file (optionally pinned to a symbol), verify it, and save it.')
  .argument('<target>', 'the source file, optionally followed by #symbol')
  .option('--quick', 'a Quick Drill, small enough for a short wait')
  .option('--no-train', 'only save the Drill, without opening the runner')
  .option('-y, --yes', 'consent to sending code to the configured provider without prompting', false)
  .option('--no-sandbox', 'run Workout code without isolation, for this invocation only')
  .action(generationCommand('drill'));

program
  .command('kata')
  .description('Generate a Kata from a file (optionally pinned to a symbol): one piece removed, for you to rebuild from a brief.')
  .argument('<target>', 'the source file, optionally followed by #symbol')
  .option('--quick', 'a Quick Kata, small enough for a short wait')
  .option('--no-train', 'only save the Kata, without opening the runner')
  .option('-y, --yes', 'consent to sending code to the configured provider without prompting', false)
  .option('--no-sandbox', 'run Workout code without isolation, for this invocation only')
  .action(generationCommand('kata'));

program
  .command('predict')
  .description('Generate a Prediction: a plain-English Scenario about what your code does, with four outcomes to choose from. No code to read.')
  .argument('[target]', 'a source file (optionally #symbol), or a directory to pick a file from (default: the whole repository)')
  .option('--commit <sha>', 'ask what a commit changed: the code before it becomes one of the wrong answers')
  .option('--what-if [change]', 'what would happen with a change nobody has made: your sentence, or leave it out for the model to propose one')
  .option('--questions <n>', 'how many questions to ask about the unit, 1 to 5 (default: predictionQuestions in your config, else 3)', questionCount)
  .option('--rule [words]', 'ask whether the code follows a business rule: from .fiu-rules.md, Understand-Anything, or as you write it (no words: list the rules)')
  .option('--no-train', 'only save the Prediction, without opening the runner')
  .option('-y, --yes', 'consent to sending code to the configured provider without prompting', false)
  .option('--no-sandbox', 'run Workout code without isolation, for this invocation only')
  .action(async (target: string | undefined, options: { commit?: string; questions?: number; whatIf?: string | true; rule?: string | true; train: boolean; yes: boolean; sandbox: boolean }) => {
    if (options.rule !== undefined && (options.commit || options.whatIf || (options.questions ?? 1) > 1)) throw new Error('A Prediction about a rule asks one question about today\'s code: leave out --commit, --what-if and --questions.');
    if (options.rule === true) {
      const { listRules } = await import('./commands/drill.ts');
      const rules = await listRules(process.cwd());
      const { NO_RULES, RULE_SOURCE_LABEL } = await import('./atlas/rules.ts');
      if (rules.length === 0) return log.info(NO_RULES);
      const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
      const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);
      const mark = (agrees: boolean | undefined, stale: boolean, waiting?: string) => (waiting ? '?' : agrees === undefined ? ' ' : stale ? '◐' : agrees ? '✓' : '✗');
      console.log(
        [
          `Business rules: fiu predict --rule "<words>"   ${dim('✓ the code follows it  ✗ it does not (as a Prediction measured)  ◐ that code changed since: check again  ? a check waits for your answer')}`,
          ...rules.map((entry) => {
            const { rule, target: where, agrees, stale, staleReason } = entry;
            const waiting = 'waiting' in entry ? entry.waiting : undefined;
            const was = waiting ? ` (answer it: fiu train ${waiting})` : stale ? ` (was ${agrees ? 'followed' : 'not followed'}; ${staleReason})` : '';
            const from = rule.source === 'understand-anything' ? ' (UA)' : ` (${RULE_SOURCE_LABEL[rule.source]})`;
            return `${mark(agrees, stale, waiting)} ${rule.text}${dim(from)}\n    ${dim(where ? `→ ${where}${was}` : '→ ? (name the code: fiu predict <file>#<symbol> --rule "…")')}`;
          }),
        ].join('\n'),
      );
      return;
    }
    if (options.whatIf && options.commit) throw new Error('A What-if is about a change nobody has made: leave out --commit.');
    if (options.whatIf && options.questions !== undefined && options.questions > 1) throw new Error('A What-if asks one question: leave out --questions.');
    if (!options.commit) return generationCommand('prediction')(target, { ...options, rule: typeof options.rule === 'string' ? options.rule : undefined });
    if (target) throw new Error('Give either a target or --commit, not both: a commit chooses its own file.');
    if (options.questions !== undefined && options.questions > 1) throw new Error('A Prediction from a commit asks one question: leave out --questions.');
    await runRefill({ ...options, background: false, kinds: ['prediction'] });
  });

program
  .command('diagnose')
  .description('Generate a Diagnosis: a practice incident in plain English and four possible Causes, each measured. No code to read.')
  .argument('[target]', 'a source file (optionally #symbol), or a directory to pick a file from (default: the whole repository)')
  .option('--no-train', 'only save the Diagnosis, without opening the runner')
  .option('-y, --yes', 'consent to sending code to the configured provider without prompting', false)
  .option('--no-sandbox', 'run Workout code without isolation, for this invocation only')
  .action(generationCommand('diagnosis'));

program
  .command('mcp')
  .description("Run Fiu's MCP server (stdio), so your coding agent can create Drills. Started by the agent, not by hand.")
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

const agent = program.command('agent').description('Set up your coding agent to create Drills with Fiu.');

agent
  .command('install')
  .argument('<agent>', 'the coding agent: claude (Claude Code)')
  .description("Install Fiu's skill, /fiu-drill command, and MCP server for your coding agent.")
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
      fiuCommand: fiuCommand(),
    });
    for (const path of report.written) log.step(`Wrote ${path}`);
    for (const path of report.removed) log.step(`Removed ${path}`);
    if (report.manualMcpCommand) {
      log.warn(`Couldn't register the MCP server with the claude CLI. Run this yourself:\n${report.manualMcpCommand}`);
    } else {
      log.step('Registered the fiu MCP server with Claude Code');
    }
    log.success('Done. In Claude Code, ask for a drill or a kata (or type /fiu-drill <file> [kata]), then start it with fiu train.');
  });

agent
  .command('uninstall')
  .argument('<agent>', 'the coding agent: claude (Claude Code)')
  .description('Remove what `fiu agent install` added.')
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
  return `Paused: the queue is full (${queued} of ${cap} Workouts waiting), so new commits won't get Drills until you attempt or \`fiu discard\` one (or raise the cap with \`fiu auto on --queue-cap <n>\`).`;
}

function assertClaude(name: string): void {
  if (name !== 'claude') {
    throw new Error(`Only "claude" (Claude Code) has an installer so far. Other MCP clients can run \`${fiuCommand().join(' ')} mcp\` as a stdio server.`);
  }
}

/** How to start this same `fiu` again, independent of the PATH the agent sees. */
function fiuCommand(): string[] {
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
      ...(report.atlas.count > 0 ? [row('Atlas', report.atlas)] : []),
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
  .argument('[path]', 'the module directory')
  .option('--about <goal>', 'choose the module by what you want to learn, through the Atlas, instead of a path')
  .option('--flow [name]', "follow a business flow from Understand-Anything's domain graph instead of a module (no name: list the flows)")
  .option('--kinds <list>', 'the kinds of step to use, e.g. drill,kata (default: all four; only no-code kinds if your kinds setting lists only those)', trackKindList)
  .option('-y, --yes', 'consent to sending code and to the estimated cost without prompting', false)
  .option('--no-sandbox', 'run Workout code without isolation, for this invocation only')
  .option('--no-train', 'only build the Track, without opening its first step')
  .action(async (path: string | undefined, options: { yes: boolean; sandbox: boolean; train: boolean; about?: string; flow?: string | true; kinds?: WorkoutKind[] }) => {
    if ([path !== undefined, options.about !== undefined, options.flow !== undefined].filter(Boolean).length !== 1) {
      throw new Error('Name the module directory, say what you want to learn with --about "<goal>", or follow a flow with --flow "<name>" (one of them).');
    }
    const { explore, listFlows } = await import('./commands/explore.ts');
    if (options.flow === true) {
      const { MIN_STEPS } = await import('./explore/plan.ts');
      const flows = await listFlows(process.cwd());
      const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
      const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);
      const lines = flows.map(({ flow, files }) => `${files >= MIN_STEPS ? '  ' : dim('· ')}${flow.name}${flow.domain ? dim(` (${flow.domain})`) : ''}  ${dim(`${files} file(s)${files >= MIN_STEPS ? '' : `: a Track needs ${MIN_STEPS}`}`)}`);
      console.log([`Understand-Anything's flows (UA): fiu explore --flow "<name>"`, ...lines].join('\n'));
      return;
    }
    const flow = typeof options.flow === 'string' ? options.flow : undefined;
    const ui = terminalUi();
    let result;
    try {
      result = await explore(process.cwd(), path ?? '', { ...options, flow }, ui);
    } finally {
      ui.settle();
    }
    if (result.status === 'plan-failed') {
      log.error(`Couldn't choose the Track's steps:\n${result.problems.map((p) => `- ${p}`).join('\n')}`);
      process.exitCode = 1;
      return;
    }
    if (result.status === 'declined') {
      log.info('No Drills generated. (Choosing the steps was a single small call, already recorded in `fiu cost`.)');
      return;
    }
    for (const drop of result.dropped) log.warn(`Dropped ${drop}`);
    if (result.status === 'not-enough') {
      log.error(`Only ${result.workoutIds.length} step(s) could be Verified, too few for a Track. They're kept as ordinary Workouts: ${result.workoutIds.join(', ') || 'none'}.`);
      process.exitCode = 1;
      return;
    }
    log.success(`Saved the Track "${result.track.title}" (${result.track.id}) with ${result.track.steps.length} steps: ${result.track.steps.map((s) => NOUN[s.kind ?? 'drill']).join(', ')}.`);
    if (options.train && process.stdin.isTTY) await runTrack(result.track.id, options);
    else log.info(`Start it with: fiu track ${result.track.id}`);
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
        log.info('No Tracks yet. Build one with: fiu explore <module-directory>');
        return;
      }
      // One Track opens directly, but only where there's a terminal to train in.
      if (listing.length > 1 || !process.stdin.isTTY) {
        log.message(listing.map(({ track, done, total }) => `${track.id}  ${done}/${total}  ${track.title}`).join('\n'));
        log.info('Continue one with: fiu track <track-id>');
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
  if (result.status === 'track-complete') log.success('Every step of this Track has been attempted. Redo any step with: fiu train <workout-id>');
  else if (result.status === 'completed' || result.status === 'abandoned') log.info(`Next step: fiu track ${id}`);
}

program
  .command('share')
  .description("Share Workouts, whole Tracks, or the Atlas with your team on the repository's fiu/workouts branch.")
  .argument('[ids...]', 'Workout or Track ids')
  .option('--atlas', "share the Atlas too, merged with the team's")
  .option('--remote <name>', 'the remote to share through (default: share.remote in config, else origin)')
  .action(async (ids: string[], options: { remote?: string; atlas?: boolean }) => {
    const { share } = await import('./sharing/share.ts');
    const report = await share(process.cwd(), ids, options);
    for (const warning of report.warnings) log.warn(warning);
    for (const item of report.shared) log.success(`Shared ${item.kind} ${item.id}${item.as !== item.id ? ` as ${item.as} (a different Workout already had its id)` : ''}`);
    for (const id of report.alreadyShared) log.info(`${id} was already shared`);
    if (report.atlas) log[report.atlas.changed ? 'success' : 'info'](report.atlas.changed ? `Shared the Atlas: the team's now has ${report.atlas.entries} entries.` : 'The team already has your Atlas.');
    if (report.shared.length > 0 || report.atlas?.changed) log.info(`Teammates get them with: fiu fetch  (branch fiu/workouts on ${report.remote})`);
  });

program
  .command('fetch')
  .description("Bring in Workouts and Tracks your team shared, re-verifying each in your sandbox.")
  .option('--remote <name>', 'the remote to fetch from (default: share.remote in config, else origin)')
  .option('--no-sandbox', "run teammates' Workout code without isolation, for this invocation only")
  .action(async (options: { remote?: string; sandbox: boolean }) => {
    const { fetchWorkouts } = await import('./sharing/share.ts');
    const ui = terminalUi();
    let report;
    try {
      report = await fetchWorkouts(process.cwd(), options, (m) => ui.step(m));
    } finally {
      ui.settle();
    }
    if (report.nothingShared) {
      log.info(`Nothing has been shared on ${report.remote} yet.`);
      return;
    }
    for (const item of report.imported) log.success(`Fetched ${item.id}${item.as !== item.id ? ` as ${item.as}` : ''}`);
    for (const item of report.tracks) log.success(`Fetched Track ${item.id}: start it with fiu track ${item.as}`);
    for (const item of report.rejected) log.warn(`Skipped ${item.id}: it didn't re-verify here (${item.reason})`);
    for (const item of report.skippedTracks) log.warn(`Skipped Track ${item.id}: ${item.reason}`);
    const atlasNews = report.atlas ? report.atlas.added + report.atlas.replaced : 0;
    if (report.atlas && atlasNews > 0) log.success(`Fetched ${atlasNews} Atlas entr${atlasNews === 1 ? 'y' : 'ies'} (${report.atlas.added} new, ${report.atlas.replaced} replacing out-of-date ones): see them with fiu map`);
    if (report.imported.length === 0 && report.tracks.length === 0 && atlasNews === 0) log.info('You already have everything your team has shared.');
  });

program
  .command('map')
  .description('Your comprehension debt in this repository, by directory: local and free.')
  .argument('[path]', 'a directory to look into')
  .option('--json', 'print the map as JSON')
  .option('--flows', "by business flow from Understand-Anything's domain graph, with its rules, instead of by directory")
  .action(async (path: string | undefined, options: { json?: boolean; flows?: boolean }) => {
    if (options.flows) {
      if (path !== undefined) throw new Error('The flow map covers the whole repository: leave out the directory.');
      const { buildFlowMap, renderFlowMap } = await import('./map/flows.ts');
      const report = await buildFlowMap(process.cwd());
      console.log(options.json ? JSON.stringify(report, null, 2) : renderFlowMap(report, { color: process.stdout.isTTY === true && !process.env.NO_COLOR }));
      return;
    }
    const { buildMap } = await import('./map/map.ts');
    const report = await buildMap(process.cwd(), path ?? '');
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const { renderMap } = await import('./map/render.ts');
    console.log(renderMap(report, { color: process.stdout.isTTY === true && !process.env.NO_COLOR }));
  });

const atlas = program.command('atlas').description('What each folder, file, and key function is for: so you can choose what to practise.');

atlas
  .command('show', { isDefault: true })
  .description('Show the Atlas: the overview, each folder and file, and their key functions.')
  .argument('[path]', 'a folder, or a file to show with its links (default: the repository)')
  .option('--markdown', 'print it as a Markdown document')
  .action(async (path: string | undefined, options: { markdown?: boolean }) => {
    const { atlasView } = await import('./commands/atlas.ts');
    const { renderAtlasMarkdown, renderAtlasText } = await import('./atlas/render.ts');
    const view = await atlasView(process.cwd(), path);
    console.log(options.markdown ? renderAtlasMarkdown(view, new Date()) : renderAtlasText(view, { color: process.stdout.isTTY === true && !process.env.NO_COLOR }));
  });

atlas
  .command('search')
  .description('Find the files and functions to practise for what you want to learn: local and free.')
  .argument('<goal...>', 'what you want to learn, in your own words')
  .option('--all', 'show every match, not just the best 10')
  .action(async (goal: string[], options: { all?: boolean }) => {
    const { searchAtlasCommand } = await import('./commands/atlas.ts');
    const { SEARCH_RESULTS, targetOf } = await import('./atlas/search.ts');
    const { results, described, notice } = await searchAtlasCommand(process.cwd(), goal.join(' '));
    const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
    const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);
    const marks = { red: '●', amber: '◐', green: '✓', grey: '·' } as const;
    if (results.length === 0) {
      log.info(`Nothing matches "${goal.join(' ')}".${described ? '' : ' Only names are searched until the Atlas is built: `fiu atlas build`, or ask your agent: /fiu-atlas'}`);
      return;
    }
    const shown = options.all ? results : results.slice(0, SEARCH_RESULTS);
    const lines: string[] = [];
    for (const result of shown) {
      lines.push(`${marks[result.state]} ${targetOf(result)}`);
      if (result.text) lines.push(dim(`    ${result.stale ? '≈ ' : ''}${result.text.replace(/\n/g, ' ')}${result.source ? ' (UA)' : ''}`));
      lines.push(result.tooLong ? dim('    too long to drill: its file is over 3,000 lines') : `    fiu drill ${targetOf(result)}`);
    }
    if (shown.length < results.length) lines.push(dim(`… and ${results.length - shown.length} more: --all`));
    lines.push('', dim('● complex, never practised   ◐ out of date or AI-changed   ✓ practised. Swap drill for kata (rebuild it) or predict (say what it does, no code reading).'));
    if (!described) lines.push(dim('Matched on names only: `fiu atlas build` (or /fiu-atlas) adds what each file and function is for.'));
    if (notice) lines.push(dim(notice));
    console.log(lines.join('\n'));
  });

atlas
  .command('build')
  .description('Describe what is missing or stale in the Atlas, deepest folders first (the whole repository, or one folder).')
  .argument('[dir]', 'a folder to describe (default: the repository)')
  .option('-y, --yes', 'consent to sending code and to the estimated cost without prompting', false)
  .action(async (dir: string | undefined, options: { yes: boolean }) => {
    const { buildAtlas } = await import('./commands/atlas.ts');
    const ui = terminalUi();
    let result;
    try {
      result = await buildAtlas(process.cwd(), dir, options, ui);
    } finally {
      ui.settle();
    }
    const uaNote = (n: number) => (n > 0 ? ` ${n} file(s) use Understand-Anything's current descriptions instead, marked (UA).` : '');
    if (result.status === 'up-to-date') return log.success(`The Atlas is up to date: nothing is missing or stale.${uaNote(result.fromUa)}`);
    if (result.status === 'declined') return log.info('Nothing described.');
    for (const failure of result.failed) log.warn(`Couldn't describe ${failure.folder || 'the repository overview'}:\n${failure.problems.map((p) => `- ${p}`).join('\n')}`);
    log.success(`Described ${result.folders} folder(s) and ${result.files} file(s), ${describeCost(result.cost)}.${uaNote(result.fromUa)} See them with \`fiu map\`, or search with \`fiu atlas search "<goal>"\`.`);
    if (result.failed.length > 0) process.exitCode = 1;
  });

program
  .command('stats')
  .description('How often your Predictions and Diagnoses are right, how well your confidence matches, and your Blind Spots: local and free.')
  .argument('[path]', 'a directory or file to look into')
  .option('--json', 'print the stats as JSON')
  .action(async (path: string | undefined, options: { json?: boolean }) => {
    const { answerStats } = await import('./map/stats.ts');
    const { renderStats } = await import('./map/render.ts');
    const repoRoot = await findRepoRoot(process.cwd());
    const scope = path ? join(process.cwd(), path).slice(repoRoot.length).replace(/^\/+|\/+$/g, '') : '';
    const stats = await answerStats(process.cwd(), scope);
    console.log(options.json ? JSON.stringify(stats, null, 2) : renderStats(stats, { color: process.stdout.isTTY === true && !process.env.NO_COLOR }));
  });

program
  .command('quick')
  .description('Start the best Quick Workout in the queue right away: for a short wait.')
  .option('--no-sandbox', 'run the tests without isolation, for this invocation only')
  .option('--while <cmd>', 'run a slow command (a build, tests) in the background meanwhile; exits with its exit code')
  .action(async (options: { sandbox: boolean; while?: string }) => {
    if (options.while !== undefined) return quickWhileCommand(options.while, options);
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
        log.info('Make one with `fiu drill --quick <file>`, or ask your agent: `/fiu-drill <file> quick`.');
      }
    } else if (result.status === 'completed' || result.status === 'abandoned') {
      log.info(`Attempt ${result.attempt} kept at ${result.dir}.`);
    }
  });

program
  .command('refill')
  .description('Generate a Quick Workout from a commit (the latest by default), of the kind your "kinds" setting prefers. The git hook runs this in the background.')
  .option('--commit <sha>', 'the commit to generate from (default: HEAD)')
  .option('--background', 'run unattended, as the hook does: never prompts, needs `fiu auto on`, obeys the caps')
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
  .option('--rules', 'also check business rules: a commit changing code where a rule is pinned or already checked gets a rule check')
  .option('--model <id>', 'the model background generation uses (default: your main model), e.g. a cheaper one')
  .action(async (options: { yes: boolean; queueCap?: string; dailyLimit?: string; aiOnly?: boolean; rules?: boolean; model?: string }) => {
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
      ...(options.rules ? { ruleChecks: true } : {}),
      ...(options.model ? { model: options.model } : {}),
    };
    const hook = await enableAuto({
      paths,
      repoConfig,
      provider: config.provider,
      model: config.model,
      fiuCommand: fiuCommand(),
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
    log.success(`Background generation is off.${removed ? ` Removed Fiu's block from ${path}.` : ''}`);
  });

auto
  .command('status')
  .description('Show whether background generation is on, today’s usage, the queue, and recent failures.')
  .action(async () => {
    const { autoStatus } = await import('./background/auto.ts');
    const paths = workspacePaths(await findRepoRoot(process.cwd()));
    const s = await autoStatus(paths, await loadRepoConfig(paths.configFile));
    const lines = [
      `Background generation: ${s.enabled ? 'on' : 'off'}${s.enabled && !s.hookInstalled ? ' (no hook in .git/hooks: add it to your hook manager, or run fiu auto on again)' : ''}`,
      `Today: ${s.generationsToday} of ${s.caps.dailyLimit} generations used`,
      `Queue: ${s.queued} of ${s.caps.queueCap} Workouts waiting${s.backlog ? `; ${s.backlog} commit(s) in the backlog` : ''}`,
      ...(s.enabled && s.paused ? [pausedMessage(s.queued, s.caps.queueCap)] : []),
      ...(s.caps.aiOnly ? ['Only AI-authored commits'] : []),
      ...(s.model ? [`Model: ${s.model}`] : []),
      `Rule checks: ${s.ruleChecks ? 'on (commits changing code where a rule is pinned or already checked)' : 'off (fiu auto on --rules)'}`,
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

async function runRefill(options: { commit?: string; background: boolean; yes?: boolean; sandbox: boolean; train: boolean; kinds?: PreferredKind[] }): Promise<void> {
  const { refill } = await import('./background/refill.ts');
  if (options.background) {
    // Unattended: say nothing, decide nothing; everything goes to .fiu/log.
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
        const kind = outcome.generation?.status === 'saved' ? outcome.generation.record.kind : 'drill';
        log.success(`Saved a Quick ${NOUN[kind]} from ${commit} (${outcome.source}): ${outcome.workoutId}`);
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
/** `fiu quick --while`: never stands between the user and their command; with nothing to serve, it just runs it. */
async function quickWhileCommand(command: string, options: { sandbox: boolean }): Promise<void> {
  const foreground = async (note?: string) => {
    if (note) log.message(styleText('dim', note));
    process.exitCode = await runInForeground(command, { cwd: process.cwd() });
  };
  if (!process.stdin.isTTY) return foreground();
  let repoRoot: string;
  try {
    repoRoot = await findRepoRoot(process.cwd());
  } catch {
    return foreground();
  }
  if (!existsSync(workspacePaths(repoRoot).root)) return foreground();

  const io = terminalTrainIo();
  let result;
  try {
    result = await quickWhile(process.cwd(), command, options, io);
  } finally {
    io.close();
  }
  if (result.status === 'nothing-ready') return foreground('No Quick Workout is ready (make some with `fiu refill` or `/fiu-drill <file> quick`).');
  process.exitCode = result.result.exitCode;
}

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
  if (result.status === 'nothing-pending') log.info('No Workouts waiting. Create one with: fiu drill <file>');
  else if (result.status === 'completed' || result.status === 'abandoned') {
    log.info(`Attempt ${result.attempt} kept at ${result.dir}. Redo it any time with: fiu train ${result.workoutId}`);
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
  .argument('<workout-id>', 'the Workout to archive, or a Series id for its unanswered questions')
  .description('Archive a Workout: hidden from the queue, but kept. Undo with fiu restore.')
  .action(async (id: string) => {
    const paths = workspacePaths(await findRepoRoot(process.cwd()));
    if (id.startsWith('series_')) {
      const discarded = await discardSeries(paths, id);
      if (discarded.length === 0) return log.info(`Every question of ${id} is already answered: nothing to discard.`);
      return log.success(`Discarded ${discarded.length} unanswered question(s) of ${id}. Bring one back with: fiu restore <workout-id>\n${discarded.map((d) => `  ${d}`).join('\n')}`);
    }
    await discardWorkout(paths, id, 'manual');
    log.success(`Discarded ${id}. Bring it back with: fiu restore ${id}`);
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
  console.error(`fiu: ${(error as Error).message}`);
  process.exitCode = 1;
}
