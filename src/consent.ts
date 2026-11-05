import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { Provider, RepoConfig } from './config.ts';

export class ConsentRequiredError extends Error {
  constructor(provider: Provider) {
    super(`Fiutsu needs your consent before sending code from this repository to ${provider}. Re-run interactively, or pass --yes.`);
  }
}

export class ConsentDeclinedError extends Error {
  constructor() {
    super('Consent declined: nothing was sent.');
  }
}

/** Consent is per repository and per provider: switching provider asks again. */
export function hasConsent(config: RepoConfig, provider: Provider): boolean {
  return config.consent?.provider === provider;
}

/** Records consent in .fiutsu/config.json, keeping everything else in the file as it was. */
export async function recordConsent(configFile: string, provider: Provider, now = new Date()): Promise<void> {
  const raw = existsSync(configFile) ? JSON.parse(await readFile(configFile, 'utf8')) : {};
  raw.consent = { provider, grantedAt: now.toISOString() };
  await writeFile(configFile, JSON.stringify(raw, null, 2) + '\n');
}
