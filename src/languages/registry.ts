import { extname } from 'node:path';
import { BUILTIN_PROFILES } from './builtin.ts';
import type { LanguageProfile, UserProfile } from './profile.ts';

export class UnsupportedLanguageError extends Error {
  constructor(file: string, profiles: readonly LanguageProfile[]) {
    const known = profiles.flatMap((p) => p.extensions).join(', ');
    super(`No Language Profile handles ${file}. Supported extensions: ${known}. You can declare your own profile in config.`);
  }
}

/**
 * The built-in profiles plus those declared in config. A declared profile replaces a built-in one
 * with the same id, and wins for any extension it claims. Repo-level profiles win over user-level ones.
 */
export function profiles(repoProfiles: UserProfile[] = [], userProfiles: UserProfile[] = []): LanguageProfile[] {
  const declared = [...repoProfiles, ...userProfiles];
  const result: LanguageProfile[] = [];
  for (const profile of [...declared, ...BUILTIN_PROFILES]) {
    if (result.some((p) => p.id === profile.id)) continue;
    const claimed = new Set(result.flatMap((p) => p.extensions));
    const extensions = profile.extensions.filter((ext) => !claimed.has(ext));
    if (extensions.length > 0) result.push({ ...profile, extensions });
  }
  return result;
}

/** A Workout's language is that of the source file it was derived from. */
export function profileForFile(file: string, available: readonly LanguageProfile[]): LanguageProfile {
  const extension = extname(file).toLowerCase();
  const profile = available.find((p) => p.extensions.includes(extension));
  if (!profile) throw new UnsupportedLanguageError(file, available);
  return profile;
}
