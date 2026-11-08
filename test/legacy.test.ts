import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { migrateFromFormerNames } from '../src/legacy.ts';
import { SpendSchema } from '../src/workouts/store.ts';
import { tempDir, tempGitRepo } from './helpers.ts';

const FIU = ['/usr/bin/node', '/opt/fiu/dist/cli.js'];

async function setup() {
  const repo = await tempGitRepo();
  const home = await tempDir();
  const configEnv = { env: { XDG_CONFIG_HOME: join(home, '.config') }, home };
  return { repo, home, configEnv, migrate: (cwd = repo) => migrateFromFormerNames({ cwd, configEnv, fiuCommand: FIU }) };
}

describe('moving from the former names (Fiutsu, Kintsugi)', () => {
  it("moves the repository's workspace and hides the new one from git", async () => {
    const { repo, migrate } = await setup();
    await mkdir(join(repo, '.kintsugi', 'workouts', 'w1'), { recursive: true });
    await writeFile(join(repo, '.kintsugi', 'state.json'), '{"outcomes":[]}\n');

    const notices = await migrate(join(repo));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /Moved this repository's \.kintsugi\/ to \.fiu\//);
    assert.ok(!existsSync(join(repo, '.kintsugi')));
    assert.equal(await readFile(join(repo, '.fiu', 'state.json'), 'utf8'), '{"outcomes":[]}\n');
    assert.ok(existsSync(join(repo, '.fiu', 'workouts', 'w1')));
    assert.match(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/\.fiu\/$/m);
    assert.equal((await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout, '');

    assert.deepEqual(await migrate(), [], 'only once');
  });

  it('moves the user config (where API keys live)', async () => {
    const { home, migrate } = await setup();
    await mkdir(join(home, '.config', 'kintsugi'), { recursive: true });
    await writeFile(join(home, '.config', 'kintsugi', 'config.json'), '{"apiKeys":{}}\n');

    const notices = await migrate(home);
    assert.match(notices.join('\n'), /Moved your Kintsugi settings/);
    assert.equal(await readFile(join(home, '.config', 'fiu', 'config.json'), 'utf8'), '{"apiKeys":{}}\n');
    assert.ok(!existsSync(join(home, '.config', 'kintsugi')));
  });

  it('never overwrites: when both names exist, the old one is left alone', async () => {
    const { repo, migrate } = await setup();
    await mkdir(join(repo, '.kintsugi'), { recursive: true });
    await mkdir(join(repo, '.fiu'), { recursive: true });
    assert.deepEqual(await migrate(), []);
    assert.ok(existsSync(join(repo, '.kintsugi')));
  });

  it("replaces Kintsugi's hook block in place, keeping the user's own lines", async () => {
    const { repo, migrate } = await setup();
    const hook = join(repo, '.git', 'hooks', 'post-commit');
    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
    await writeFile(
      hook,
      "#!/bin/sh\n# Created by Kintsugi (kin auto on).\necho mine\n\n# >>> kintsugi >>>\n( nohup '/old/kin' 'refill' & )\n# <<< kintsugi <<<\necho also-mine\n",
    );

    assert.deepEqual(await migrate(), ['Updated the post-commit hook to start Fiu under its new name.']);
    const updated = await readFile(hook, 'utf8');
    assert.match(updated, /^#!\/bin\/sh\n# Created by Fiu \(fiu auto on\)\.\necho mine\n/);
    assert.match(updated, /# >>> fiu >>>[\s\S]*'\/opt\/fiu\/dist\/cli\.js' 'refill' '--background'[\s\S]*# <<< fiu <<<\necho also-mine\n$/);
    assert.doesNotMatch(updated, /kintsugi|\/old\/kin/);
  });

  it("reminds the user to replace Kintsugi's agent skill", async () => {
    const { home, migrate } = await setup();
    await mkdir(join(home, '.claude', 'skills', 'kintsugi'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'kintsugi', 'SKILL.md'), '<!-- kintsugi-version: 5.1.0 -->');
    assert.match((await migrate(home)).join('\n'), /run `fiu agent install claude`/);
  });

  it("moves Fiutsu's workspace and config", async () => {
    const { repo, home, migrate } = await setup();
    await mkdir(join(repo, '.fiutsu'), { recursive: true });
    await writeFile(join(repo, '.fiutsu', 'state.json'), '{"outcomes":[]}\n');
    await mkdir(join(home, '.config', 'fiutsu'), { recursive: true });
    await writeFile(join(home, '.config', 'fiutsu', 'config.json'), '{"apiKeys":{}}\n');

    const notices = (await migrate()).join('\n');
    assert.match(notices, /Moved your Fiutsu settings/);
    assert.match(notices, /Moved this repository's \.fiutsu\/ to \.fiu\/ \(Fiutsu is now Fiu\)/);
    assert.equal(await readFile(join(repo, '.fiu', 'state.json'), 'utf8'), '{"outcomes":[]}\n');
    assert.equal(await readFile(join(home, '.config', 'fiu', 'config.json'), 'utf8'), '{"apiKeys":{}}\n');
    assert.ok(!existsSync(join(repo, '.fiutsu')));
    assert.ok(!existsSync(join(home, '.config', 'fiutsu')));
    assert.equal((await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout, '');
  });

  it("prefers Fiutsu's workspace when both former names are there, leaving Kintsugi's alone", async () => {
    const { repo, migrate } = await setup();
    await mkdir(join(repo, '.kintsugi'), { recursive: true });
    await writeFile(join(repo, '.kintsugi', 'state.json'), 'kintsugi\n');
    await mkdir(join(repo, '.fiutsu'), { recursive: true });
    await writeFile(join(repo, '.fiutsu', 'state.json'), 'fiutsu\n');

    await migrate();
    assert.equal(await readFile(join(repo, '.fiu', 'state.json'), 'utf8'), 'fiutsu\n');
    assert.ok(existsSync(join(repo, '.kintsugi')));
  });

  it("replaces Fiutsu's hook block in place", async () => {
    const { repo, migrate } = await setup();
    const hook = join(repo, '.git', 'hooks', 'post-commit');
    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
    await writeFile(hook, "#!/bin/sh\n# Created by Fiutsu (fiu auto on).\n\n# >>> fiutsu >>>\n( nohup '/old/fiutsu' 'refill' & )\n# <<< fiutsu <<<\necho mine\n");

    assert.equal((await migrate()).length, 1);
    const updated = await readFile(hook, 'utf8');
    assert.match(updated, /^#!\/bin\/sh\n# Created by Fiu \(fiu auto on\)\.\n/);
    assert.match(updated, /# >>> fiu >>>[\s\S]*'\/opt\/fiu\/dist\/cli\.js' 'refill'[\s\S]*# <<< fiu <<<\necho mine\n$/);
    assert.doesNotMatch(updated, /fiutsu/);
    assert.deepEqual(await migrate(), [], 'only once');
  });

  it("reminds the user to replace Fiutsu's agent skill", async () => {
    const { home, migrate } = await setup();
    await mkdir(join(home, '.claude', 'skills', 'fiutsu'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'fiutsu', 'SKILL.md'), '<!-- fiutsu-version: 6.0.0 -->');
    assert.match((await migrate(home)).join('\n'), /run `fiu agent install claude`/);
  });

  it('reads spend entries recorded as generated by Fiutsu or Kintsugi', () => {
    const entry = SpendSchema.shape.generator;
    assert.equal(entry.parse('fiutsu'), 'fiu');
    assert.equal(entry.parse('kintsugi'), 'fiu');
    assert.equal(entry.parse('agent'), 'agent');
    assert.equal(entry.parse(undefined), 'fiu');
  });
});
