import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import type { ImportStyle, LanguageProfile } from '../languages/profile.ts';
import { profileForFile } from '../languages/registry.ts';
import type { WorkspacePaths } from '../workspace.ts';
import type { Skeleton } from './skeleton.ts';

/**
 * How co-change is counted (§11.15). Commits touching more files than `maxFilesPerCommit` are renames,
 * formatting passes, or lockfile bumps: they say nothing about which files depend on each other.
 */
export const CO_CHANGE = { commits: 500, maxFilesPerCommit: 20, minShared: 3, minRatio: 0.3, kept: 5 } as const;

/**
 * A hub changes with so many files (a CLI entry point, a central registry) that "changes with it" says
 * nothing: at least a third of the files that changed at all, and at least 5. Measured on Fiu's own
 * history, where it singles out `src/cli.ts` (27 of 65) and leaves `src/workouts/save.ts` (21) alone.
 */
export const HUB = { share: 1 / 3, minPartners: 5 } as const;

const CoChangeSchema = z.object({
  path: z.string(),
  /** Commits that changed both files. */
  shared: z.number(),
  /** `shared` over the commits of whichever of the two files changed less. */
  ratio: z.number(),
});
export type CoChange = z.infer<typeof CoChangeSchema>;

const FileLinksSchema = z.object({
  /** In-repository files this one imports; a Go package is its folder, with a trailing `/`. */
  imports: z.array(z.string()),
  /** Files that import this one (or, in Go, its package). */
  importedBy: z.array(z.string()),
  /** Files that change in the same commits, most shared commits first. */
  changesWith: z.array(CoChangeSchema),
  /** Commits among the last `CO_CHANGE.commits` that changed this file. */
  commits: z.number(),
});
export type FileLinks = z.infer<typeof FileLinksSchema>;

const LinksSchema = z.object({
  version: z.literal(1),
  /** The commit and the code the links were computed from: recomputed when either changes. */
  key: z.string(),
  /** How many commits co-change looked at (fewer than `CO_CHANGE.commits` in a young repository). */
  commitsRead: z.number(),
  /** Files that change with too many others for co-change with them to mean anything (`HUB`). */
  hubs: z.array(z.string()),
  files: z.record(z.string(), FileLinksSchema),
});
export type Links = z.infer<typeof LinksSchema>;

export const NO_LINKS: FileLinks = { imports: [], importedBy: [], changesWith: [], commits: 0 };

/**
 * The Atlas's links: computed from the code and git history, never by a model, so correct by
 * construction (ADR 0009). Only between described files: tests and generated code would drown the signal.
 * Cached in `.fiu/links.json` while HEAD and the code stay the same.
 */
export async function loadLinks(paths: Pick<WorkspacePaths, 'repoRoot' | 'root' | 'linksFile'>, skeleton: Skeleton, profiles: readonly LanguageProfile[]): Promise<Links> {
  const { repoRoot } = paths;
  const described = [...skeleton.files.values()].filter((f) => f.described).sort((a, b) => a.path.localeCompare(b.path));
  const head = await execa('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repoRoot, reject: false });
  const key = createHash('sha1')
    .update(`${head.exitCode === 0 ? head.stdout.trim() : 'no-commits'}\n`)
    .update(described.map((f) => `${f.path} ${f.hash}`).join('\n'))
    .digest('hex');

  if (existsSync(paths.linksFile)) {
    const cached = LinksSchema.safeParse(JSON.parse(await readFile(paths.linksFile, 'utf8').catch(() => 'null')));
    if (cached.success && cached.data.key === key) return cached.data;
  }

  const sources = new Map<string, { source: string; style: ImportStyle }>();
  for (const file of described) {
    const style = profileForFile(file.path, profiles).importStyle;
    if (!style) continue;
    const source = await readFile(posix.join(repoRoot, file.path), 'utf8').catch(() => undefined);
    if (source !== undefined) sources.set(file.path, { source, style });
  }
  const imports = await importGraph(repoRoot, sources, new Set(described.map((f) => f.path)));
  const history = await coChange(repoRoot, new Set(described.map((f) => f.path)));
  const links: Links = { version: 1, key, commitsRead: history.commitsRead, hubs: history.hubs, files: {} };
  for (const file of described) {
    links.files[file.path] = {
      imports: imports.imports.get(file.path) ?? [],
      importedBy: imports.importedBy.get(file.path) ?? [],
      changesWith: history.changesWith.get(file.path) ?? [],
      commits: history.commits.get(file.path) ?? 0,
    };
  }

  if (existsSync(paths.root)) {
    const temporary = `${paths.linksFile}.tmp`;
    await writeFile(temporary, JSON.stringify(links) + '\n');
    await rename(temporary, paths.linksFile);
  }
  return links;
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
const folderOf = (path: string) => (posix.dirname(path) === '.' ? '' : posix.dirname(path));

/** Who imports whom, among `files`. Imports that don't resolve to one of them (packages, the standard library) are left out. */
export async function importGraph(
  repoRoot: string,
  sources: Map<string, { source: string; style: ImportStyle }>,
  files: Set<string>,
): Promise<{ imports: Map<string, string[]>; importedBy: Map<string, string[]> }> {
  const goModules = [...sources.values()].some((s) => s.style === 'go') ? await readGoModules(repoRoot) : [];
  const imports = new Map<string, string[]>();
  const importedBy = new Map<string, Set<string>>();
  const addImportedBy = (target: string, by: string) => {
    if (target === by) return;
    if (!importedBy.has(target)) importedBy.set(target, new Set());
    importedBy.get(target)!.add(by);
  };

  for (const [path, { source, style }] of sources) {
    const targets =
      style === 'relative' ? relativeImports(path, source, files) : style === 'python' ? pythonImports(path, source, files) : goImports(path, source, files, goModules);
    const own = targets.filter((target) => target !== path && target !== `${folderOf(path)}/`);
    imports.set(path, sorted(own));
    for (const target of own) {
      if (target.endsWith('/')) {
        // A Go package: every file of the folder is used by the importer.
        const folder = target.slice(0, -1);
        for (const file of files) if (folderOf(file) === folder) addImportedBy(file, path);
      } else addImportedBy(target, path);
    }
  }
  return { imports, importedBy: new Map([...importedBy].map(([target, by]) => [target, sorted(by)])) };
}

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** TypeScript lets `./x.js` name `./x.ts`. */
const TS_FOR_JS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]*)['"]/g;

/** `import … from './x'`, `export … from '../y'`, `import('./z')`, `require('./w')`: relative paths only. */
export function relativeImports(path: string, source: string, files: Set<string>): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
    const resolved = posix.normalize(posix.join(folderOf(path), match[1]!));
    if (resolved.startsWith('..')) continue;
    const extension = posix.extname(resolved);
    const stem = extension ? resolved.slice(0, -extension.length) : resolved;
    const candidates = [
      resolved,
      ...(TS_FOR_JS[extension] ?? []).map((ext) => stem + ext),
      ...SCRIPT_EXTENSIONS.map((ext) => resolved + ext),
      ...SCRIPT_EXTENSIONS.map((ext) => posix.join(resolved, `index${ext}`)),
    ];
    const target = candidates.find((candidate) => files.has(candidate));
    if (target) found.push(target);
  }
  return found;
}

/**
 * `import a.b`, `from a.b import c`, `from . import d`, `from ..e import f`. An absolute module is looked
 * for from the repository root and from each folder above the file (a `src/` layout, or a script's own
 * folder on `sys.path`); `from a import b` also tries `a/b.py`, since `b` may be a submodule.
 */
export function pythonImports(path: string, source: string, files: Set<string>): string[] {
  const found: string[] = [];
  const folders = folderOf(path) === '' ? [] : folderOf(path).split('/');
  const roots = ['', ...folders.map((_, i) => folders.slice(0, i + 1).join('/'))];
  const moduleFile = (base: string, dotted: string): string | undefined => {
    const stem = posix.join(base, ...dotted.split('.').filter(Boolean));
    return [`${stem}.py`, posix.join(stem, '__init__.py')].find((candidate) => files.has(candidate));
  };
  const resolve = (module: string): string | undefined => {
    const dots = /^\.*/.exec(module)![0].length;
    if (dots === 0) return roots.map((root) => moduleFile(root, module)).find(Boolean);
    const up = folders.slice(0, Math.max(0, folders.length - (dots - 1)));
    if (folders.length - (dots - 1) < 0) return undefined;
    const rest = module.slice(dots);
    return rest === '' ? undefined : moduleFile(up.join('/'), rest);
  };

  for (const line of source.split('\n')) {
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\s+\(?([^#)]*)/.exec(line);
    if (from) {
      const module = from[1]!;
      const names = from[2]!.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]!.trim()).filter((n) => /^\w+$/.test(n));
      const own = resolve(module);
      if (own && !own.endsWith('__init__.py')) {
        found.push(own);
        continue;
      }
      const sep = module.endsWith('.') || module === '' ? '' : '.';
      const submodules = names.map((name) => resolve(`${module}${sep}${name}`)).filter((target): target is string => target !== undefined);
      found.push(...(submodules.length > 0 ? submodules : own ? [own] : []));
      continue;
    }
    const plain = /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/.exec(line);
    if (plain) {
      for (const part of plain[1]!.split(',')) {
        const target = resolve(part.trim().split(/\s+as\s+/)[0]!);
        if (target) found.push(target);
      }
    }
  }
  return found;
}

interface GoModule {
  /** The folder holding go.mod, relative to the repository root. */
  dir: string;
  name: string;
}

async function readGoModules(repoRoot: string): Promise<GoModule[]> {
  const { stdout } = await execa('git', ['ls-files', '-z', '--', 'go.mod', '**/go.mod'], { cwd: repoRoot, reject: false });
  const modules: GoModule[] = [];
  for (const file of stdout.split('\0').filter(Boolean)) {
    const text = await readFile(posix.join(repoRoot, file), 'utf8').catch(() => '');
    const name = /^\s*module\s+(\S+)/m.exec(text)?.[1];
    if (name) modules.push({ dir: folderOf(file), name });
  }
  // The longest module name first, so a nested module wins over the one around it.
  return modules.sort((a, b) => b.name.length - a.name.length);
}

const GO_IMPORT_BLOCK = /^\s*import\s*\(([\s\S]*?)\)/gm;
const GO_IMPORT_LINE = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;

/** Go imports a package, which is a folder: a link to a package under one of the repository's modules is a link to its folder. */
export function goImports(path: string, source: string, files: Set<string>, modules: GoModule[]): string[] {
  const specs: string[] = [];
  for (const block of source.matchAll(GO_IMPORT_BLOCK)) for (const spec of block[1]!.matchAll(/"([^"]+)"/g)) specs.push(spec[1]!);
  for (const line of source.matchAll(GO_IMPORT_LINE)) specs.push(line[1]!);
  const folders = new Set([...files].filter((f) => f.endsWith('.go')).map(folderOf));
  const found: string[] = [];
  for (const spec of specs) {
    const module = modules.find((m) => spec === m.name || spec.startsWith(`${m.name}/`));
    if (!module) continue;
    const folder = posix.join(module.dir, spec.slice(module.name.length + 1));
    const normalized = folder === '.' ? '' : folder;
    if (folders.has(normalized) && normalized !== folderOf(path)) found.push(`${normalized}/`);
  }
  return found;
}

/** Which of `files` changed together in the last `CO_CHANGE.commits` commits (merges and mass commits left out). */
export async function coChange(
  repoRoot: string,
  files: Set<string>,
): Promise<{ commitsRead: number; commits: Map<string, number>; changesWith: Map<string, CoChange[]>; hubs: string[] }> {
  const log = await execa('git', ['log', '-n', String(CO_CHANGE.commits), '--no-merges', '--no-renames', '--format=%x1e', '--name-only'], {
    cwd: repoRoot,
    reject: false,
  });
  const commits = new Map<string, number>();
  const pairs = new Map<string, number>();
  let commitsRead = 0;
  if (log.exitCode === 0) {
    for (const entry of log.stdout.split('\x1e').slice(1)) {
      commitsRead++;
      const changed = entry.split('\n').map((line) => line.trim()).filter(Boolean);
      if (changed.length > CO_CHANGE.maxFilesPerCommit) continue;
      const own = sorted(changed.filter((path) => files.has(path)));
      for (const path of own) commits.set(path, (commits.get(path) ?? 0) + 1);
      for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) {
        const pair = `${own[i]}\0${own[j]}`;
        pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
      }
    }
  }

  const changesWith = new Map<string, CoChange[]>();
  const add = (path: string, link: CoChange) => {
    if (!changesWith.has(path)) changesWith.set(path, []);
    changesWith.get(path)!.push(link);
  };
  for (const [pair, shared] of pairs) {
    if (shared < CO_CHANGE.minShared) continue;
    const [a, b] = pair.split('\0') as [string, string];
    const ratio = shared / Math.min(commits.get(a)!, commits.get(b)!);
    if (ratio < CO_CHANGE.minRatio) continue;
    add(a, { path: b, shared, ratio });
    add(b, { path: a, shared, ratio });
  }
  const partnersForHub = Math.max(HUB.minPartners, Math.ceil(commits.size * HUB.share));
  const hubs = sorted([...changesWith].filter(([, links]) => links.length >= partnersForHub).map(([path]) => path));
  for (const [path, links] of changesWith) {
    links.sort((x, y) => y.shared - x.shared || y.ratio - x.ratio || x.path.localeCompare(y.path));
    changesWith.set(path, links.slice(0, CO_CHANGE.kept));
  }
  return { commitsRead, commits, changesWith, hubs };
}
