import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ConfigError,
  DEFAULTS,
  loadRepoConfig,
  loadUserConfig,
  resolveConfig,
  userConfigPath,
  type ConfigEnv,
} from '../src/config.ts';
import { MissingApiKeyError, resolveApiKey } from '../src/credentials.ts';
import { tempDir } from './helpers.ts';

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

describe('userConfigPath', () => {
  it('defaults to ~/.config/kintsugi', () => {
    assert.equal(userConfigPath({ env: {}, home: '/home/u' }), '/home/u/.config/kintsugi/config.json');
  });

  it('honours XDG_CONFIG_HOME', () => {
    assert.equal(userConfigPath({ env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/u' }), '/xdg/kintsugi/config.json');
  });
});

describe('loadRepoConfig', () => {
  it('treats a missing file as empty', async () => {
    assert.deepEqual(await loadRepoConfig(join(await tempDir(), 'config.json')), {});
  });

  it('refuses API keys with a pointer to where they belong', async () => {
    const file = join(await tempDir(), 'config.json');
    await writeJson(file, { apiKeys: { anthropic: 'sk-secret' } });
    await assert.rejects(loadRepoConfig(file), (error: Error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /must not contain API keys/);
      assert.doesNotMatch(error.message, /sk-secret/);
      return true;
    });
  });

  it('rejects unknown fields and unknown providers', async () => {
    const file = join(await tempDir(), 'config.json');
    await writeJson(file, { provider: 'acme' });
    await assert.rejects(loadRepoConfig(file), ConfigError);
    await writeJson(file, { colour: 'gold' });
    await assert.rejects(loadRepoConfig(file), ConfigError);
  });
});

describe('resolveConfig', () => {
  it('falls back to defaults', () => {
    const { provider, model, profiles } = resolveConfig({}, {});
    assert.deepEqual({ provider, model }, DEFAULTS);
    assert.deepEqual(profiles.map((p) => p.id), ['typescript', 'javascript', 'python', 'go']);
  });

  it('prefers repo over user settings', () => {
    const { provider, model } = resolveConfig({ model: 'repo-model' }, { provider: 'openai', model: 'user-model' });
    assert.deepEqual({ provider, model }, { provider: 'openai', model: 'repo-model' });
  });
});

describe('resolveApiKey', () => {
  const configEnv = (env: NodeJS.ProcessEnv): ConfigEnv => ({ env, home: '/home/u' });

  it('reads the key from the user config', async () => {
    const home = await tempDir();
    await writeJson(join(home, '.config', 'kintsugi', 'config.json'), { apiKeys: { anthropic: 'from-file' } });
    const user = await loadUserConfig({ env: {}, home });
    assert.equal(resolveApiKey('anthropic', user, configEnv({})), 'from-file');
  });

  it('prefers the environment over the user config', () => {
    const user = { apiKeys: { openai: 'from-file' } };
    assert.equal(resolveApiKey('openai', user, configEnv({ OPENAI_API_KEY: 'from-env' })), 'from-env');
  });

  it('explains where to put a missing key', () => {
    assert.throws(() => resolveApiKey('google', {}, configEnv({})), (error: Error) => {
      assert.ok(error instanceof MissingApiKeyError);
      assert.match(error.message, /GOOGLE_GENERATIVE_AI_API_KEY/);
      assert.match(error.message, /\/home\/u\/\.config\/kintsugi\/config\.json/);
      return true;
    });
  });
});
