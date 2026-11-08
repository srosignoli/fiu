import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { execa } from 'execa';

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fiu-test-'));
  after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function tempGitRepo(): Promise<string> {
  const dir = await tempDir();
  await execa('git', ['init', '-q'], { cwd: dir });
  return dir;
}
