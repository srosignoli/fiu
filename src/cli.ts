#!/usr/bin/env node
import { join } from 'node:path';
import { confirm, log, spinner } from '@clack/prompts';
import { Command } from 'commander';
import { costReport, startOfMonth, type SpendBucket } from './commands/cost.ts';
import { drill, type DrillUi } from './commands/drill.ts';
import { describeCost, formatUsd, totalTokens } from './cost/usage.ts';
import { EDITOR_TIP, init } from './commands/init.ts';
import { train, type TrainResult } from './commands/train.ts';
import { terminalTrainIo } from './terminal.ts';

const program = new Command()
  .name('kintsugi')
  .description('Turn real code from your repository into small, verified practice Workouts.')
  .version('0.0.0');

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
  .option('--no-train', 'only save the Drill, without opening the runner')
  .option('-y, --yes', 'consent to sending code to the configured provider without prompting', false)
  .option('--no-sandbox', 'run Workout code without isolation, for this invocation only')
  .action(async (target: string, options: { train: boolean; yes: boolean; sandbox: boolean }) => {
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
      row('Workouts finished', report.finished),
      row('Workouts not finished', report.notFinished, report.notFinished.count > 0 ? '   paid for, not used yet' : ''),
      row('Produced nothing', report.producedNothing),
    ];
    if (Object.keys(report.byOrigin).length > 1) {
      for (const [origin, bucket] of Object.entries(report.byOrigin)) lines.push(row(`From ${origin}`, bucket));
    }
    for (const usage of report.unpriced) {
      const tokens = totalTokens({ usage: [usage], usd: 0, unpricedModels: [], pricesAsOf: '' });
      lines.push(`  Not priced: ${tokens.toLocaleString('en-US')} tokens from ${usage.model} (add it under "prices" in config)`);
    }
    lines.push(`Estimates use list prices as of ${report.pricesAsOf}; your provider's bill is authoritative.`);
    log.message(lines.join('\n'));
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
  if (result.status === 'nothing-pending') log.info('No pending Workouts. Create one with: kin drill <file>');
  else if (result.status === 'completed' || result.status === 'abandoned') log.info(`Moved to ${result.dir}`);
}

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
