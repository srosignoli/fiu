import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

/** The branch teammates share Workouts on (ADR 0006). */
export const SHARED_BRANCH = 'fiutsu/workouts';
/** Fiutsu's private copy of the remote branch: no local branch appears in `git branch`. */
export const SHARED_REF = 'refs/fiutsu/workouts';
/** The shared branch's name up to v5.1, when Fiutsu was called Kintsugi: still read, never written. */
export const LEGACY_SHARED_BRANCH = 'kintsugi/workouts';

const git = (repo: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}) =>
  execa('git', args, { cwd: repo, reject: false, ...options });

export class SharingError extends Error {}

/**
 * Fetches the shared branch into SHARED_REF; returns its commit, or undefined when nothing has been shared yet.
 * A remote that only has the branch from before the rename (Kintsugi) is read from that one, so the next
 * share continues its history on SHARED_BRANCH.
 */
export async function fetchShared(repo: string, remote: string): Promise<string | undefined> {
  const listed = await git(repo, ['ls-remote', '--heads', remote, SHARED_BRANCH, LEGACY_SHARED_BRANCH]);
  if (listed.exitCode !== 0) throw new SharingError(`Can't reach the remote "${remote}": ${listed.stderr.trim().split('\n')[0]}`);
  const heads = listed.stdout.split('\n').map((line) => line.split('\t')[1]);
  const branch = heads.includes(`refs/heads/${SHARED_BRANCH}`) ? SHARED_BRANCH : heads.includes(`refs/heads/${LEGACY_SHARED_BRANCH}`) ? LEGACY_SHARED_BRANCH : undefined;
  if (!branch) return undefined;
  const fetched = await git(repo, ['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${branch}:${SHARED_REF}`]);
  if (fetched.exitCode !== 0) throw new SharingError(`Couldn't fetch ${branch} from "${remote}": ${fetched.stderr.trim().split('\n')[0]}`);
  return (await git(repo, ['rev-parse', SHARED_REF])).stdout.trim();
}

/** Every file in a commit's tree, by path, as blob ids. */
export async function readTree(repo: string, commit: string | undefined): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  if (!commit) return files;
  const { stdout } = await git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  for (const entry of stdout.split('\0').filter(Boolean)) {
    const [meta, path] = entry.split('\t');
    const [, type, blob] = meta!.split(' ');
    if (type === 'blob') files.set(path!, blob!);
  }
  return files;
}

export async function readBlob(repo: string, blob: string): Promise<Buffer> {
  // Byte for byte: execa would otherwise strip a file's final newline.
  const result = await execa('git', ['cat-file', 'blob', blob], { cwd: repo, encoding: 'buffer', stripFinalNewline: false });
  return Buffer.from(result.stdout);
}

/** Stores a file's content in the object database, returning its blob id. */
export async function hashFile(repo: string, path: string): Promise<string> {
  return (await execa('git', ['hash-object', '-w', '--', path], { cwd: repo })).stdout.trim();
}

/**
 * A commit whose tree is `parent`'s tree plus `additions` (path → blob), built in a temporary index so
 * the user's own index, working tree, and current branch are never touched.
 */
export async function commitWith(repo: string, parent: string | undefined, additions: Map<string, string>, message: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fiutsu-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    if (parent) await execa('git', ['read-tree', parent], { cwd: repo, env });
    const indexInfo = [...additions].map(([path, blob]) => `100644 ${blob}\t${path}`).join('\n') + '\n';
    await execa('git', ['update-index', '--add', '--index-info'], { cwd: repo, env, input: indexInfo });
    const tree = (await execa('git', ['write-tree'], { cwd: repo, env })).stdout.trim();
    const committed = await git(repo, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
    if (committed.exitCode !== 0) throw new SharingError(`Couldn't create the sharing commit: ${committed.stderr.trim().split('\n')[0]}`);
    return committed.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Pushes `commit` as the shared branch. `rejected` means a teammate pushed first: fetch, combine, and try again. */
export async function pushShared(repo: string, remote: string, commit: string): Promise<'pushed' | 'rejected'> {
  const pushed = await git(repo, ['push', '--quiet', remote, `${commit}:refs/heads/${SHARED_BRANCH}`]);
  if (pushed.exitCode === 0) {
    await git(repo, ['update-ref', SHARED_REF, commit]);
    return 'pushed';
  }
  if (/non-fast-forward|fetch first|rejected/i.test(pushed.stderr)) return 'rejected';
  throw new SharingError(`Couldn't push ${SHARED_BRANCH} to "${remote}": ${pushed.stderr.trim().split('\n')[0]}`);
}

/** True when some remote-tracking branch contains the commit, so teammates can resolve it. */
export async function onSomeRemoteBranch(repo: string, commit: string): Promise<boolean> {
  const { stdout } = await git(repo, ['branch', '-r', '--contains', commit]);
  return stdout.trim() !== '';
}

export async function gitIdentity(repo: string): Promise<{ name: string; email: string }> {
  const name = (await git(repo, ['config', 'user.name'])).stdout.trim();
  const email = (await git(repo, ['config', 'user.email'])).stdout.trim();
  if (!name || !email) throw new SharingError('Set your git user.name and user.email first: shared Workouts are stamped with who shared them.');
  return { name, email };
}
