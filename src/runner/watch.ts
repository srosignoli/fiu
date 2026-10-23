import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface WatchOptions {
  /** Paths relative to the directory that never trigger a run. */
  ignore: (path: string) => boolean;
  /** Quiet period after the last event before checking for changes. */
  debounceMs?: number;
}

/**
 * Calls `onChange` when the content of a watched file actually changes and has settled. Editors' temp
 * files, touch-without-change, half-written saves, and files in ignored paths don't count.
 */
export async function watchForChanges(dir: string, onChange: () => void, { ignore, debounceMs = 150 }: WatchOptions): Promise<{ close(): void }> {
  let fingerprint = await contentFingerprint(dir, ignore);
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  // Saves usually truncate then write: act only on content that has settled across two reads.
  const check = async () => {
    let next = await contentFingerprint(dir, ignore);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, debounceMs));
      if (closed) return;
      const again = await contentFingerprint(dir, ignore);
      if (again === next) break;
      next = again;
    }
    if (next === fingerprint) return;
    fingerprint = next;
    onChange();
  };
  const watcher: FSWatcher = watch(dir, { recursive: true }, (_event, filename) => {
    if (filename && ignore(filename.split(sep).join('/'))) return;
    clearTimeout(timer);
    timer = setTimeout(() => void check(), debounceMs);
  });
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
    },
  };
}

export async function contentFingerprint(dir: string, ignore: (path: string) => boolean): Promise<string> {
  const hash = createHash('sha256');
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !ignore(path))
    .sort();
  for (const path of files) {
    hash.update(path).update('\0');
    try {
      hash.update(await readFile(join(dir, path)));
    } catch {
      // Deleted between listing and reading: its absence is part of the fingerprint.
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}
