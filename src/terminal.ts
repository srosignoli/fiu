import { spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { isCancel, log, select, spinner } from '@clack/prompts';
import type { TrainIo } from './commands/train.ts';
import { describeCost } from './cost/usage.ts';
import { shellQuote } from './sandbox/process.ts';

export class NotInteractiveError extends Error {
  constructor() {
    super('kin train needs an interactive terminal.');
  }
}

/** Single keypresses from stdin, in raw mode. Ctrl+C reads as "q". */
class KeyReader {
  readonly #waiters = new Set<(key: string | undefined) => void>();
  readonly #onKeypress = (text: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
    const name = key?.ctrl && key.name === 'c' ? 'q' : (key?.name ?? text);
    if (!name) return;
    for (const waiter of this.#waiters) waiter(name);
    this.#waiters.clear();
  };

  constructor() {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', this.#onKeypress);
  }

  read(signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter = (key: string | undefined) => resolve(key);
      this.#waiters.add(waiter);
      signal?.addEventListener('abort', () => {
        this.#waiters.delete(waiter);
        resolve(undefined);
      });
    });
  }

  close(): void {
    process.stdin.off('keypress', this.#onKeypress);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

/** The real terminal for `kin train`. Call `close()` when done to restore the terminal. */
export function terminalTrainIo(): TrainIo & { close(): void } {
  if (!process.stdin.isTTY) throw new NotInteractiveError();
  let keys: KeyReader | undefined;
  const reader = () => (keys ??= new KeyReader());
  return {
    print: (text) => console.log(`\n${text}`),
    readKey: (signal) => reader().read(signal),
    async pick(workouts) {
      // The picker needs cooked mode; it runs before any key reading starts.
      const choice = await select({
        message: 'Which Workout?',
        options: workouts.map((w) => ({
          value: w.record.id,
          label: w.record.title,
          hint: [w.status === 'in-progress' ? 'open Attempt' : 'new', w.record.id, ...(w.record.cost ? [describeCost(w.record.cost)] : [])].join(', '),
        })),
      });
      return isCancel(choice) ? undefined : workouts.find((w) => w.record.id === choice);
    },
    async rate() {
      console.log('\nWas this a good Workout? [y] 👍  [n] 👎  [any other key] skip');
      const key = await reader().read();
      return key === 'y' ? 'up' : key === 'n' ? 'down' : undefined;
    },
    async confirmDefect() {
      console.log('\nIs it a real bug in your code? [y] yes  [n] no  [any other key] skip');
      const key = await reader().read();
      return key === 'y' ? true : key === 'n' ? false : undefined;
    },
    openEditor(files) {
      const editor = process.env.VISUAL;
      if (!editor) return;
      // A GUI editor (code, subl, …) opens alongside; it must not take over this terminal.
      const child = spawn(`${editor} ${files.map(shellQuote).join(' ')}`, { shell: true, detached: true, stdio: 'ignore' });
      child.on('error', (error) => log.warn(`Could not open $VISUAL: ${error.message}`));
      child.unref();
    },
    async wait(status, until) {
      const progress = spinner();
      progress.start(status());
      const timer = setInterval(() => progress.message(status()), 1000);
      try {
        await until;
      } finally {
        clearInterval(timer);
        progress.stop('Done waiting.');
      }
    },
    close: () => keys?.close(),
  };
}
