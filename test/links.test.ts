import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { CO_CHANGE, coChange, goImports, loadLinks, pythonImports, relativeImports } from '../src/atlas/links.ts';
import { renderAtlasText } from '../src/atlas/render.ts';
import { buildSkeleton } from '../src/atlas/skeleton.ts';
import { emptyAtlas } from '../src/atlas/store.ts';
import { atlasView } from '../src/commands/atlas.ts';
import { UserProfileSchema } from '../src/languages/profile.ts';
import { profiles } from '../src/languages/registry.ts';
import { ensureWorkspace, workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';

const files = (...paths: string[]) => new Set(paths);

async function write(repo: string, path: string, content = '') {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), content);
}

async function commit(repo: string, changes: Record<string, string>, message = 'change') {
  for (const [path, content] of Object.entries(changes)) await write(repo, path, content);
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message], { cwd: repo });
}

describe('relative imports (JavaScript, TypeScript)', () => {
  it('resolves explicit extensions, .js naming .ts, missing extensions, and index files', () => {
    const source = [
      "import { a } from './a.ts';",
      "import type { B } from '../lib/b.js';",
      "export * from './c';",
      "const d = await import('./d/index.ts');",
      "const e = require('./e');",
      "import {\n  f,\n} from './dir';",
      "import x from 'some-package';",
      "import y from 'node:fs';",
    ].join('\n');
    const all = files('src/a.ts', 'lib/b.ts', 'src/c.tsx', 'src/d/index.ts', 'src/e.cjs', 'src/dir/index.ts');
    assert.deepEqual(relativeImports('src/main.ts', source, all).sort(), ['lib/b.ts', 'src/a.ts', 'src/c.tsx', 'src/d/index.ts', 'src/dir/index.ts', 'src/e.cjs']);
  });

  it('ignores what resolves outside the repository or to no file', () => {
    assert.deepEqual(relativeImports('main.ts', "import '../outside.ts';\nimport './missing.ts';", files('main.ts')), []);
  });
});

describe('Python imports', () => {
  const all = files('app/__init__.py', 'app/models.py', 'app/db/__init__.py', 'app/db/session.py', 'app/api/routes.py', 'src/pkg/core.py', 'src/pkg/cli.py', 'tools/run.py', 'tools/helpers.py');

  it('resolves absolute modules, submodules, and packages from the repository root', () => {
    const source = 'import app.models\nfrom app.db import session\nfrom app import db\nimport os, json\n';
    assert.deepEqual(pythonImports('app/api/routes.py', source, all).sort(), ['app/db/__init__.py', 'app/db/session.py', 'app/models.py']);
  });

  it('resolves relative imports', () => {
    assert.deepEqual(pythonImports('app/db/session.py', 'from .. import models\nfrom ..models import User\n', all).sort(), ['app/models.py', 'app/models.py']);
  });

  it('resolves a src/ layout and a script beside its helpers', () => {
    assert.deepEqual(pythonImports('src/pkg/cli.py', 'from pkg.core import run\n', all), ['src/pkg/core.py']);
    assert.deepEqual(pythonImports('tools/run.py', 'import helpers\n', all), ['tools/helpers.py']);
  });
});

describe('Go imports', () => {
  it("links a package under the repository's module to its folder", () => {
    const source = 'package api\n\nimport (\n\t"fmt"\n\tq "example.com/shop/internal/queue"\n\t"example.com/shop/internal/missing"\n)\n\nimport "example.com/shop/store"\n';
    const all = files('internal/queue/queue.go', 'store/store.go', 'api/api.go');
    assert.deepEqual(goImports('api/api.go', source, all, [{ dir: '', name: 'example.com/shop' }]).sort(), ['internal/queue/', 'store/']);
  });
});

describe('co-change', () => {
  it('counts files changed together, leaving out weak pairs and mass commits', async () => {
    const repo = await tempGitRepo();
    for (let i = 0; i < 3; i++) await commit(repo, { 'a.ts': `${i}`, 'b.ts': `${i}` });
    await commit(repo, { 'a.ts': 'solo', 'c.ts': 'x' });
    // A rename-sized commit: everything changes, and it says nothing about coupling.
    const mass: Record<string, string> = {};
    for (let i = 0; i <= CO_CHANGE.maxFilesPerCommit; i++) mass[`f${i}.ts`] = 'm';
    await commit(repo, { ...mass, 'a.ts': 'mass', 'c.ts': 'mass' });

    const result = await coChange(repo, files('a.ts', 'b.ts', 'c.ts'));
    assert.equal(result.commitsRead, 5);
    assert.equal(result.commits.get('a.ts'), 4);
    assert.deepEqual(result.changesWith.get('b.ts'), [{ path: 'a.ts', shared: 3, ratio: 1 }]);
    assert.equal(result.changesWith.get('c.ts'), undefined, 'one shared commit is not a pattern');
  });

  it('is empty in a repository with no commits', async () => {
    const result = await coChange(await tempGitRepo(), files('a.ts'));
    assert.equal(result.commitsRead, 0);
    assert.equal(result.changesWith.size, 0);
  });
});

describe('loadLinks', () => {
  it('links source files both ways, skips tests, caches by commit and code, and recomputes on change', async () => {
    const repo = await tempGitRepo();
    const paths = workspacePaths(repo);
    await ensureWorkspace(paths);
    await commit(repo, {
      'src/queue.ts': 'export const q = 1;\n',
      'src/worker.ts': "import { q } from './queue.ts';\n",
      'src/worker.test.ts': "import { q } from './queue.ts';\n",
    });
    const all = profiles();
    const links = await loadLinks(paths, await buildSkeleton(repo, all), all);
    assert.deepEqual(links.files['src/queue.ts']?.importedBy, ['src/worker.ts'], 'tests are not links');
    assert.deepEqual(links.files['src/worker.ts']?.imports, ['src/queue.ts']);
    assert.equal(links.files['src/worker.test.ts'], undefined);
    assert.ok(existsSync(paths.linksFile));

    const cached = await readFile(paths.linksFile, 'utf8');
    await loadLinks(paths, await buildSkeleton(repo, all), all);
    assert.equal(await readFile(paths.linksFile, 'utf8'), cached, 'same commit and code: reused');

    await write(repo, 'src/worker.ts', 'export const w = 2;\n');
    const changed = await loadLinks(paths, await buildSkeleton(repo, all), all);
    assert.deepEqual(changed.files['src/queue.ts']?.importedBy, [], 'an uncommitted edit is seen');
  });

  it('works without a workspace, writing nothing', async () => {
    const repo = await tempGitRepo();
    await commit(repo, { 'a.py': 'import b\n', 'b.py': '' });
    const all = profiles();
    const links = await loadLinks(workspacePaths(repo), await buildSkeleton(repo, all), all);
    assert.deepEqual(links.files['a.py']?.imports, ['b.py']);
    assert.ok(!existsSync(workspacePaths(repo).root));
  });

  it('gives no import links to a user language without an import style', async () => {
    const repo = await tempGitRepo();
    await commit(repo, { 'a.rb': "require_relative './b'\n", 'b.rb': '' });
    const ruby = UserProfileSchema.parse({ id: 'ruby', extensions: ['.rb'], codeFilename: 'kata.rb', testFilename: 'kata_test.rb', preflightCmd: 'ruby -v', testCmd: 'ruby kata_test.rb', resultFormat: 'tap' });
    const all = profiles([ruby]);
    const links = await loadLinks(workspacePaths(repo), await buildSkeleton(repo, all), all);
    assert.deepEqual(links.files['a.rb']?.imports, []);
    assert.throws(() => UserProfileSchema.parse({ ...ruby, importStyle: 'ruby' }));
  });
});

describe('fiu atlas <file>', () => {
  it("shows the file's entry and its links", async () => {
    const repo = await tempGitRepo();
    for (let i = 0; i < 3; i++) await commit(repo, { 'src/queue.ts': `export const q = ${i};\n`, 'src/worker.ts': `import { q } from './queue.ts';\nexport const n = ${i};\n` });
    const view = await atlasView(repo, 'src/queue.ts', { configEnv: { env: {}, home: await tempDir() } });
    assert.equal(view.file, 'src/queue.ts');
    const text = renderAtlasText({ ...view, atlas: { ...emptyAtlas(), files: { 'src/queue.ts': { hash: view.skeleton.files.get('src/queue.ts')!.hash, text: 'The job queue.', writtenAt: '', functions: {} } } } }, { color: false });
    assert.match(text, /^src\/queue\.ts\nWritten by a model from the code; not Verified\.\n\nThe job queue\./);
    assert.match(text, /Used by: +src\/worker\.ts/);
    assert.match(text, /Uses: +none found/);
    assert.match(text, /Changes with: +src\/worker\.ts \(together in 3 commits\)/);
    assert.match(text, /Changed in: +3 of the last 3 commits/);
  });

  it('says tests have no links', async () => {
    const repo = await tempGitRepo();
    await commit(repo, { 'src/queue.test.ts': '' });
    const view = await atlasView(repo, 'src/queue.test.ts', { configEnv: { env: {}, home: await tempDir() } });
    assert.match(renderAtlasText(view, { color: false }), /Links are computed between source files only/);
  });
});
