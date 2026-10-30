import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { buildSkeleton, foldersBottomUp } from '../src/atlas/skeleton.ts';
import { emptyAtlas, folderWork, readAtlas, staleCounts, writeAtlas } from '../src/atlas/store.ts';
import { extractSymbols, keyFunctions } from '../src/atlas/symbols.ts';
import { UserProfileSchema } from '../src/languages/profile.ts';
import { profiles } from '../src/languages/registry.ts';
import { ensureWorkspace, workspacePaths } from '../src/workspace.ts';
import { tempGitRepo } from './helpers.ts';

const names = (source: string) => extractSymbols(source).map((s) => `${s.name}:${s.startLine}-${s.endLine}`);

describe('extractSymbols', () => {
  it('finds TypeScript functions, classes with their methods, arrow constants, and types', () => {
    const source = `import { x } from './x.ts';

export interface Job {
  id: string;
}

export async function pickNext(
  jobs: Job[],
  { strict = false }: { strict?: boolean } = {},
): Promise<string | undefined> {
  function inner() {
    return 1;
  }
  return jobs[0]?.id;
}

export class Queue {
  #items: Job[] = [];
  push(job: Job): void {
    if (job) this.#items.push(job);
  }
  async drain() {
    return this.#items.splice(0);
  }
}

export const size = (q: Queue) => {
  return 0;
};
export type Id = string;
`;
    assert.deepEqual(names(source), ['Job:3-5', 'pickNext:7-15', 'Queue:17-25', 'Queue.push:19-21', 'Queue.drain:22-24', 'size:27-29', 'Id:30-30']);
  });

  it('finds Python functions and methods, but not functions nested in functions', () => {
    const source = `class Node:
    def __init__(self, name):
        self.name = name

    def add(self, other):
        def helper():
            return other
        return helper()


def normalize(
    text,
):
    if text:
        return text.strip()
    return ""
`;
    assert.deepEqual(names(source), ['Node:1-8', 'Node.__init__:2-3', 'Node.add:5-8', 'normalize:11-16']);
  });

  it('names Go methods after their receiver', () => {
    const source = `package store

type Store struct {
\tdb string
}

func (s *Store) Get(id string) (string, error) {
\tif id == "" {
\t\treturn "", nil
\t}
\treturn s.db, nil
}

func New() *Store { return &Store{} }
`;
    assert.deepEqual(names(source), ['Store:3-5', 'Store.Get:7-12', 'New:14-14']);
  });

  it('uses a profile’s declarationPattern in place of the built-in patterns', () => {
    const source = 'proc first() =\n  echo 1\nproc second() =\n  echo 2\n';
    assert.deepEqual(extractSymbols(source, '^proc\\s+(?<name>\\w+)').map((s) => s.name), ['first', 'second']);
  });

  it('picks the densest functions of at least five lines as key functions', () => {
    const dense = (name: string, branches: number) =>
      `function ${name}(x) {\n${Array.from({ length: 5 }, (_, i) => (i < branches ? `  if (x > ${i}) return ${i};` : '  x++;')).join('\n')}\n}\n`;
    const source = [dense('a', 1), dense('b', 5), dense('c', 3), 'function tiny(x) {\n  if (x) return 1;\n}\n', dense('d', 2), dense('e', 4), dense('f', 0)].join('');
    assert.deepEqual(keyFunctions(extractSymbols(source)).map((s) => s.name), ['b', 'e', 'c', 'd', 'a']);
  });
});

describe('the declarationPattern setting', () => {
  const base = { id: 'nim', extensions: ['.nim'], codeFilename: 'k.nim', testFilename: 't.nim', preflightCmd: 'nim -v', testCmd: 'nim t', resultFormat: 'tap' };
  it('needs a group called name', () => {
    assert.equal(UserProfileSchema.safeParse({ ...base, declarationPattern: '^proc\\s+(?<name>\\w+)' }).success, true);
    assert.equal(UserProfileSchema.safeParse({ ...base, declarationPattern: '^proc\\s+(\\w+)' }).success, false);
    assert.equal(UserProfileSchema.safeParse({ ...base, declarationPattern: '^proc(' }).success, false);
  });
});

async function repo() {
  const dir = await tempGitRepo();
  const files: Record<string, string> = {
    'src/db/store.ts': 'export function get(id: string) {\n  if (!id) return undefined;\n  if (id === "x") return 1;\n  return id;\n}\n',
    'src/db/store.test.ts': 'test("get", () => {});\n',
    'src/ui/view.ts': 'export const view = () => 1;\n',
    'main.ts': 'console.log(1);\n',
    'README.md': '# hi\n',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

describe('buildSkeleton', () => {
  it('lists recognised files with git blob hashes, and the folders that hold them', async () => {
    const dir = await repo();
    const skeleton = await buildSkeleton(dir, profiles());
    assert.deepEqual([...skeleton.files.keys()].sort(), ['main.ts', 'src/db/store.test.ts', 'src/db/store.ts', 'src/ui/view.ts']);
    const store = skeleton.files.get('src/db/store.ts')!;
    assert.equal(store.hash, (await execa('git', ['hash-object', 'src/db/store.ts'], { cwd: dir })).stdout);
    assert.equal(store.described, true);
    assert.deepEqual(store.keyFunctions, ['get']);
    assert.deepEqual(store.symbols.map((s) => s.name), ['get']);
    assert.equal(skeleton.files.get('src/db/store.test.ts')!.described, false);
    assert.deepEqual(skeleton.folders.get('')!.folders, ['src']);
    assert.deepEqual(skeleton.folders.get('')!.files, ['main.ts']);
    assert.deepEqual(foldersBottomUp(skeleton).map((f) => f.path), ['src/db', 'src/ui', 'src', '']);
    assert.deepEqual(foldersBottomUp(skeleton, 'src/db').map((f) => f.path), ['src/db']);
  });

  it('marks entries stale when a file changes, and a folder when its files do', async () => {
    const dir = await repo();
    const paths = workspacePaths(dir);
    await ensureWorkspace(paths);
    let skeleton = await buildSkeleton(dir, profiles());
    const atlas = emptyAtlas();
    const db = skeleton.folders.get('src/db')!;
    assert.deepEqual(folderWork(atlas, skeleton, db), { files: ['src/db/store.ts'], folder: true });
    atlas.folders['src/db'] = { hash: db.hash, text: 'Data access.', writtenAt: 'now' };
    atlas.files['src/db/store.ts'] = { hash: skeleton.files.get('src/db/store.ts')!.hash, text: 'Reads records.', writtenAt: 'now', functions: {} };
    await writeAtlas(paths, atlas);
    assert.deepEqual(await readAtlas(paths), atlas);
    assert.deepEqual(folderWork(atlas, skeleton, db), { files: [], folder: false });

    await writeFile(join(dir, 'src/db/store.ts'), 'export const get = 1;\n');
    skeleton = await buildSkeleton(dir, profiles());
    assert.deepEqual(folderWork(atlas, skeleton, skeleton.folders.get('src/db')!), { files: ['src/db/store.ts'], folder: true });
    assert.deepEqual(staleCounts(atlas, skeleton), { files: 1, folders: 0, described: 1 });

    await writeFile(join(dir, 'src/db/cache.ts'), 'export const c = 1;\n');
    await execa('git', ['add', '.'], { cwd: dir });
    skeleton = await buildSkeleton(dir, profiles());
    assert.equal(staleCounts(atlas, skeleton).folders, 1);
  });
});
