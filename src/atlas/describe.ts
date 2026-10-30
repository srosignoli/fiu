import { generateText, NoObjectGeneratedError, Output, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import { usageOf, type ModelUsage } from '../cost/usage.ts';
import type { ProviderOptions } from '../synthesis/model.ts';
import type { Skeleton, SkeletonFile, SkeletonFolder } from './skeleton.ts';
import type { Atlas } from './store.ts';

/** Every Atlas line is short enough to sit beside a name in `kin map`. */
export const MAX_LINE_CHARS = 200;
export const MAX_FILE_LINES = 2;
export const MAX_OVERVIEW_LINES = 5;
/** Longer key functions are shown up to here: enough to say what a function is for. */
const MAX_BODY_LINES = 80;
/** Files described per call in API mode; a big folder takes several calls. */
export const FILES_PER_CALL = 10;

export const AtlasOutputSchema = z.object({
  folder: z.string().describe('The folder entry; for the repository root, the overview. Empty only when told it is not wanted yet.'),
  files: z.array(
    z.object({
      path: z.string().describe('A file to describe, exactly as listed.'),
      text: z.string().describe(`One or two lines: what the file is for.`),
      functions: z.array(z.object({ name: z.string().describe('A key function, named exactly as listed.'), text: z.string().describe('One line: what it is for.') })),
    }),
  ),
});
export type AtlasOutput = z.infer<typeof AtlasOutputSchema>;

/** Shared by Kintsugi's own calls and agent mode's prepare_atlas. */
export const ATLAS_RULES = `You write the Atlas of a codebase: short orientation notes that tell a developer what each folder, file, and key function is for, so they can choose what to study. You are shown one folder at a time, deepest folders first, so a folder's subfolders are already described.

Write for someone who has not read the code. Say what each thing is for and what it is responsible for, in plain words, naming the domain concepts it deals with (orders, retries, snapshots, consent), not the syntax (no "exports a function that"). Describe only what the code you are shown does: never guess at behaviour you can't see, and never judge the code's quality.

- Folder: one line, at most ${MAX_LINE_CHARS} characters: its role in the repository.
- The repository root's folder entry is the overview instead: up to ${MAX_OVERVIEW_LINES} lines saying how the codebase is organised, naming the top-level folders and what each is for.
- File: one or two lines, at most ${MAX_LINE_CHARS} characters each.
- Key function: one line, at most ${MAX_LINE_CHARS} characters. Describe every key function listed, named exactly as listed.`;

const codeLines = (source: string, from: number, to: number) => {
  const lines = source.split('\n').slice(from - 1, to);
  return lines.length > MAX_BODY_LINES ? [...lines.slice(0, MAX_BODY_LINES), `… (${lines.length - MAX_BODY_LINES} more lines)`] : lines;
};

/**
 * What one call sees: the folder's subfolders and already-described files with their entries, the
 * files it doesn't describe, and for each file to describe its declarations and key functions' code.
 * `sources` holds the files to describe, by path.
 */
export function folderPrompt(
  skeleton: Skeleton,
  atlas: Atlas,
  folder: SkeletonFolder,
  files: string[],
  sources: Map<string, string>,
  { wantFolder = true }: { wantFolder?: boolean } = {},
): string {
  const entry = (text: string | undefined) => (text ? `: ${text.replace(/\n/g, ' ')}` : ' (not described yet)');
  const others = folder.files.filter((path) => !files.includes(path));
  const sections = [
    `Folder: ${folder.path || '(repository root)'}`,
    folder.folders.length > 0 ? `Subfolders:\n${folder.folders.map((path) => `- ${path}${entry(atlas.folders[path]?.text)}`).join('\n')}` : '',
    others.length > 0
      ? `Other files in this folder:\n${others
          .map((path) => (skeleton.files.get(path)!.described ? `- ${path}${entry(atlas.files[path]?.text)}` : `- ${path} (a test or generated file: not described)`))
          .join('\n')}`
      : '',
    ...files.map((path) => fileSection(skeleton.files.get(path)!, sources.get(path) ?? '')),
    wantFolder
      ? folder.path === ''
        ? 'Write the overview of the repository as the folder entry, and describe each file above.'
        : 'Write the folder entry, and describe each file above.'
      : 'Describe each file above. Leave the folder entry empty: it is written once the rest of the folder is described.',
  ];
  return sections.filter(Boolean).join('\n\n');
}

function fileSection(file: SkeletonFile, source: string): string {
  const declarations = file.symbols.map((s) => `${s.name} (${s.startLine}-${s.endLine})`).join(', ');
  const key = file.keyFunctions.map((name) => file.symbols.find((s) => s.name === name)!);
  return [
    `### File to describe: ${file.path} (${file.lines} lines${file.tooLong ? ', too long to drill' : ''})`,
    `Declarations: ${declarations || 'none found'}`,
    key.length > 0 ? `Key functions to describe: ${key.map((s) => s.name).join(', ')}` : 'No key functions: leave functions empty.',
    ...key.map((s) => `--- ${s.name} (lines ${s.startLine}-${s.endLine})\n${codeLines(source, s.startLine, s.endLine).join('\n')}`),
    key.length === 0 ? `--- start of the file\n${codeLines(source, 1, 40).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The problems with a description of `files` in `folder`; empty when it can be saved. Also agent mode's submit_atlas check. */
export function checkAtlasOutput(
  skeleton: Skeleton,
  folder: SkeletonFolder,
  files: string[],
  output: AtlasOutput,
  { wantFolder = true }: { wantFolder?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const lines = (text: string) => text.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  const checkText = (what: string, text: string, maxLines: number) => {
    const found = lines(text);
    if (found.length === 0) problems.push(`${what} is empty.`);
    else if (found.length > maxLines) problems.push(`${what} has ${found.length} lines; at most ${maxLines}.`);
    for (const line of found) if (line.length > MAX_LINE_CHARS) problems.push(`${what} has a line of ${line.length} characters; at most ${MAX_LINE_CHARS}.`);
  };
  if (wantFolder) checkText(folder.path === '' ? 'The overview' : `The entry for the folder ${folder.path}`, output.folder, folder.path === '' ? MAX_OVERVIEW_LINES : 1);

  const seen = new Set<string>();
  for (const described of output.files) {
    if (!files.includes(described.path)) {
      problems.push(`${described.path} is not one of the files to describe here.`);
      continue;
    }
    if (seen.has(described.path)) problems.push(`${described.path} is described twice.`);
    seen.add(described.path);
    const file = skeleton.files.get(described.path)!;
    checkText(`The entry for ${described.path}`, described.text, MAX_FILE_LINES);
    const names = new Set(file.symbols.map((s) => s.name));
    for (const fn of described.functions) {
      if (!names.has(fn.name)) problems.push(`${described.path} declares no ${fn.name}: name functions exactly as listed.`);
      else checkText(`The entry for ${described.path}#${fn.name}`, fn.text, 1);
    }
    const missing = file.keyFunctions.filter((name) => !described.functions.some((fn) => fn.name === name));
    if (missing.length > 0) problems.push(`${described.path}: describe its key function(s) ${missing.join(', ')}.`);
  }
  for (const path of files) if (!seen.has(path)) problems.push(`${path} is not described.`);
  return problems;
}

/** Saves a checked description into the Atlas, tied to the content it describes. */
export function applyAtlasOutput(atlas: Atlas, skeleton: Skeleton, folder: SkeletonFolder, output: AtlasOutput, now: Date, { wantFolder = true } = {}): void {
  const writtenAt = now.toISOString();
  const tidy = (text: string) => text.trim().split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
  for (const described of output.files) {
    atlas.files[described.path] = {
      hash: skeleton.files.get(described.path)!.hash,
      text: tidy(described.text),
      writtenAt,
      functions: Object.fromEntries(described.functions.map((fn) => [fn.name, tidy(fn.text)])),
    };
  }
  if (wantFolder) atlas.folders[folder.path] = { hash: folder.hash, text: tidy(output.folder), writtenAt };
}

export interface DescribeOptions {
  skeleton: Skeleton;
  atlas: Atlas;
  folder: SkeletonFolder;
  files: string[];
  sources: Map<string, string>;
  wantFolder: boolean;
  model: LanguageModel;
  modelId: string;
  providerOptions?: ProviderOptions;
}

export type DescribeResult = { output?: AtlasOutput; problems: string[]; usage: ModelUsage[] };

/** One call (plus one retry on an unusable answer) describing some of a folder's files, and the folder when wanted. */
export async function describeFolder({ skeleton, atlas, folder, files, sources, wantFolder, model, modelId, providerOptions }: DescribeOptions): Promise<DescribeResult> {
  const messages: ModelMessage[] = [{ role: 'user', content: folderPrompt(skeleton, atlas, folder, files, sources, { wantFolder }) }];
  const usage: ModelUsage[] = [];
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await generateText({
        model,
        system: ATLAS_RULES,
        messages,
        output: Output.object({ schema: AtlasOutputSchema }),
        providerOptions,
        maxOutputTokens: 8_000,
      });
      usage.push(...usageOf(result, modelId));
      problems = checkAtlasOutput(skeleton, folder, files, result.output, { wantFolder });
      if (problems.length === 0) return { output: result.output, problems, usage };
      messages.push(...result.response.messages);
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw error;
      usage.push(...usageOf({ usage: error.usage, response: error.response }, modelId));
      problems = [`the answer was not a valid description: ${String(error.cause ?? error.message)}`];
    }
    messages.push({ role: 'user', content: `That description can't be saved:\n${problems.map((p) => `- ${p}`).join('\n')}\nGive a corrected one.` });
  }
  return { problems, usage };
}
