#!/usr/bin/env node
import { Command } from 'commander';
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

try {
  await program.parseAsync();
} catch (error) {
  console.error(`kintsugi: ${(error as Error).message}`);
  process.exitCode = 1;
}
