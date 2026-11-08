import { CO_CHANGE, NO_LINKS, type Links } from './links.ts';
import type { Skeleton, SkeletonFile } from './skeleton.ts';
import { entryState, type Atlas } from './store.ts';

export interface AtlasView {
  /** The repository's directory name. */
  name: string;
  scope: string;
  skeleton: Skeleton;
  atlas: Atlas;
  /** Set when the view is of one file: it is shown with its links. */
  file?: string;
  links?: Links;
}

const NOT_VERIFIED = 'Written by a model from the code; not Verified.';

/** The folders under the scope, outermost first, as the Atlas is read. */
function foldersTopDown({ skeleton, scope }: AtlasView) {
  return [...skeleton.folders.values()]
    .filter((f) => scope === '' || f.path === scope || f.path.startsWith(`${scope}/`))
    .sort((a, b) => a.path.localeCompare(b.path));
}

const base = (path: string) => path.split('/').pop() ?? path;

function fileNote(file: SkeletonFile, atlas: Atlas): { text?: string; stale: boolean; tags: string[] } {
  const entry = atlas.files[file.path];
  const tags = [...(file.described ? [] : ['test or generated']), ...(file.tooLong ? ['too long to drill'] : [])];
  return { ...(entry ? { text: entry.text } : {}), stale: entryState(entry, file.hash) === 'stale', tags };
}

const LINKS_NOTE = 'Links: computed from imports and git history.';
const MAX_LISTED = 10;

const listed = (paths: string[]) =>
  paths.length === 0 ? 'none found' : paths.slice(0, MAX_LISTED).join(', ') + (paths.length > MAX_LISTED ? `, and ${paths.length - MAX_LISTED} more` : '');

/** One file's links as label and value pairs, the same for text and Markdown. */
function linkRows(view: AtlasView & { file: string }): [string, string][] {
  const file = view.skeleton.files.get(view.file)!;
  if (!file.described) return [];
  const links = view.links?.files[view.file] ?? NO_LINKS;
  const hubs = new Set(view.links?.hubs ?? []);
  const changes = links.changesWith.map((c) => `${c.path} (together in ${c.shared} commits${hubs.has(c.path) ? '; changes with most files' : ''})`);
  return [
    ['Uses', listed(links.imports)],
    ['Used by', listed(links.importedBy)],
    ['Changes with', listed(changes)],
    ['Changed in', `${links.commits} of the last ${view.links?.commitsRead ?? 0} commits (not counting commits that touch over ${CO_CHANGE.maxFilesPerCommit} files)`],
  ];
}

/** `fiu atlas <file>`: the file's entry and key functions, then its computed links. */
function renderFileText(view: AtlasView & { file: string }, dim: (text: string) => string): string {
  const file = view.skeleton.files.get(view.file)!;
  const note = fileNote(file, view.atlas);
  const tags = note.tags.length > 0 ? ` (${note.tags.join(', ')})` : '';
  const lines = [`${view.file}${tags}`];
  if (note.text) lines.push(dim(NOT_VERIFIED), '', `${note.stale ? '≈ ' : ''}${note.text}`);
  else if (file.described) lines.push('', dim('(not described yet: `fiu atlas build`, or ask your agent: /fiu-atlas)'));
  for (const [name, text] of Object.entries(view.atlas.files[view.file]?.functions ?? {})) lines.push(`    #${name}  ${dim(text)}`);
  lines.push('');
  const rows = linkRows(view);
  if (rows.length === 0) lines.push(dim('Links are computed between source files only, not tests or generated code.'));
  else {
    const width = Math.max(...rows.map(([label]) => label.length)) + 2;
    lines.push(dim(LINKS_NOTE), ...rows.map(([label, value]) => `  ${`${label}:`.padEnd(width + 1)}${value}`));
  }
  return lines.join('\n').trimEnd();
}

/** `fiu atlas [<path>]`: the Atlas as indented text, folders first, then their files and key functions. */
export function renderAtlasText(view: AtlasView, { color }: { color: boolean }): string {
  const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);
  if (view.file !== undefined) return renderFileText(view as AtlasView & { file: string }, dim);
  const { skeleton, atlas } = view;
  const lines: string[] = [`Atlas of ${view.scope || view.name}`, dim(NOT_VERIFIED), ''];
  const overview = view.scope === '' ? atlas.folders[''] : undefined;
  if (overview) lines.push(...overview.text.split('\n'), '');
  let described = 0;
  for (const folder of foldersTopDown(view)) {
    const entry = atlas.folders[folder.path];
    if (folder.path !== '') {
      const stale = entryState(entry, folder.hash) === 'stale' ? '≈ ' : '';
      lines.push(`${folder.path}/  ${entry ? dim(stale + entry.text) : dim('(not described yet)')}`);
    } else if (folder.files.length === 0) continue;
    for (const path of folder.files) {
      const file = skeleton.files.get(path)!;
      const note = fileNote(file, atlas);
      if (note.text) described++;
      const tags = note.tags.length > 0 ? ` (${note.tags.join(', ')})` : '';
      lines.push(`  ${base(path)}${tags}  ${note.text ? dim((note.stale ? '≈ ' : '') + note.text.replace(/\n/g, ' ')) : file.described ? dim('(not described yet)') : ''}`.trimEnd());
      for (const [name, text] of Object.entries(atlas.files[path]?.functions ?? {})) lines.push(`      #${name}  ${dim(text)}`);
    }
    lines.push('');
  }
  if (described === 0) lines.push(dim('Nothing described yet: `fiu atlas build`, or ask your agent: /fiu-atlas'));
  return lines.join('\n').trimEnd();
}

/** `fiu atlas --markdown`: a document to read or commit. */
export function renderAtlasMarkdown(view: AtlasView, now: Date): string {
  const { skeleton, atlas } = view;
  if (view.file !== undefined) {
    const note = fileNote(skeleton.files.get(view.file)!, atlas);
    const rows = linkRows(view as AtlasView & { file: string });
    return [
      `# \`${view.file}\``,
      '',
      `> ${NOT_VERIFIED} ${LINKS_NOTE} Generated by Fiu on ${now.toISOString().slice(0, 10)}.`,
      '',
      ...(note.text ? [`${note.text}${note.stale ? ' *(may be out of date)*' : ''}`, ''] : []),
      ...Object.entries(atlas.files[view.file]?.functions ?? {}).map(([name, text]) => `- \`${name}\`: ${text}`),
      ...(Object.keys(atlas.files[view.file]?.functions ?? {}).length > 0 ? [''] : []),
      ...rows.map(([label, value]) => `- **${label}:** ${value}`),
    ].join('\n').trimEnd() + '\n';
  }
  const lines: string[] = [`# Atlas of ${view.scope ? `\`${view.scope}\`` : view.name}`, '', `> ${NOT_VERIFIED} Generated by Fiu on ${now.toISOString().slice(0, 10)}.`, ''];
  const overview = view.scope === '' ? atlas.folders[''] : undefined;
  if (overview) lines.push(...overview.text.split('\n').map((line) => `${line}  `), '');
  const outdated = (stale: boolean) => (stale ? ' *(may be out of date)*' : '');
  for (const folder of foldersTopDown(view)) {
    if (folder.path === '' && folder.files.length === 0) continue;
    const entry = atlas.folders[folder.path];
    lines.push(`## \`${folder.path || '.'}/\``, '');
    if (folder.path !== '') lines.push(entry ? `${entry.text}${outdated(entryState(entry, folder.hash) === 'stale')}` : '*Not described yet.*', '');
    for (const path of folder.files) {
      const note = fileNote(skeleton.files.get(path)!, atlas);
      const tags = note.tags.length > 0 ? ` (${note.tags.join(', ')})` : '';
      lines.push(`- **\`${base(path)}\`**${tags}${note.text ? `: ${note.text.replace(/\n/g, ' ')}${outdated(note.stale)}` : ''}`);
      for (const [name, text] of Object.entries(atlas.files[path]?.functions ?? {})) lines.push(`  - \`${name}\`: ${text}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}
