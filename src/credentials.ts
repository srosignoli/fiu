import { userConfigPath, type ConfigEnv, type Provider, type UserConfig } from './config.ts';

export const API_KEY_ENV_VARS: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

export class MissingApiKeyError extends Error {
  constructor(provider: Provider, configEnv: ConfigEnv) {
    super(
      `No API key found for ${provider}. Set ${API_KEY_ENV_VARS[provider]} ` +
        `or add "apiKeys": { "${provider}": "..." } to ${userConfigPath(configEnv)}.`,
    );
  }
}

/** Keys come only from the environment or the user-level config, never from the repo. The environment wins. */
export function resolveApiKey(provider: Provider, user: UserConfig, configEnv: ConfigEnv): string {
  const key = configEnv.env[API_KEY_ENV_VARS[provider]] || user.apiKeys?.[provider];
  if (!key) throw new MissingApiKeyError(provider, configEnv);
  return key;
}
