#!/usr/bin/env node
import { join } from 'node:path';
import { confirm, log, spinner } from '@clack/prompts';
import { Command } from 'commander';
import { drill, type DrillUi } from './commands/drill.ts';
import { EDITOR_TIP, init } from './commands/init.ts';

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
        log.warn(`Nothing worth drilling in ${target}: ${result.reason}`);
      } else if (result.status === 'failed') {
        log.error(`Couldn't produce a Verified Workout from ${target}. The last attempt failed with:\n${result.feedback}`);
        process.exitCode = 1;
      } else {
        const { record, workoutDir, testCmd } = result;
        log.success(`Saved Drill "${record.title}" (${record.id})`);
        log.message(
          [
            `Read the incident report: ${join(workoutDir, 'README.md')}`,
            `Fix the bug in:           ${join(workoutDir, record.files.code)}`,
            `Run the tests with:       cd ${workoutDir} && ${testCmd}`,
          ].join('\n'),
        );
      }
    } finally {
      ui.settle();
    }
  });

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
