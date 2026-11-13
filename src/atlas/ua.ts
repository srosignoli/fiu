import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import type { Skeleton, SkeletonFile } from './skeleton.ts';
import { entryState, type EntryState } from './store.ts';

/**
 * Understand-Anything's knowledge graph, read as orientation (ADR 0010): the model's word, labelled with
 * its source, never Links, never Verified. The only module that knows UA's format, which is not a contract:
 * every field is optional, each node, layer and tour step is parsed on its own, and a graph Fiu can't read
 * is reported and ignored, never a failure.
 */

/** Where UA keeps its graph, in UA's own order: the legacy directory wins when it exists. */
export const UA_DIRS = ['.understand-anything', '.ua'] as const;
const GRAPH_FILE = 'knowledge-graph.json';

/** The Atlas's own length limit for an entry (§11.10). */
const MAX_TEXT = 200;
/** Below this share of code nodes resolving to the skeleton, the format has probably changed. */
const MIN_MATCH_RATIO = 0.2;
/** Fewer code nodes than this say too little to judge the match ratio by. */
const MIN_NODES_TO_JUDGE = 10;

/** What a UA file contributes: its sentence, tags, layer, and its functions' sentences by Fiu symbol name. */
export interface ForeignFile {
  path: string;
  /** The file's blob hash at the commit UA analysed; absent when that commit isn't in this clone. */
  hash?: string;
  text?: string;
  tags: string[];
  layer?: string;
  /** By the skeleton's symbol name (`Class.method`): only names the skeleton has. */
  functions: Record<string, string>;
}

export interface ForeignLayer {
  name: string;
  description?: string;
  files: string[];
}

export interface ForeignTourStep {
  order: number;
  title: string;
  /** Files of the skeleton the step points at, in the step's order. */
  files: string[];
}

/** UA's graph, as Fiu uses it: only what resolves to this repository's skeleton. */
export interface ForeignAtlas {
  source: 'understand-anything';
  /** The directory it was read from, relative to the repository root. */
  dir: string;
  commit?: string;
  analyzedAt?: string;
  /** Whether the commit UA analysed is in this clone: without it, every entry counts as stale. */
  commitInClone: boolean;
  /** The project's description: an overview of the repository. */
  overview?: string;
  files: Map<string, ForeignFile>;
  layers: ForeignLayer[];
  tour: ForeignTourStep[];
  /** Code nodes (file, function, class) read, how many resolved to the skeleton, and entries skipped as unreadable. */
  counts: { codeNodes: number; matched: number; skipped: number };
}

export type ForeignAtlasResult =
  | { status: 'absent' }
  | { status: 'unreadable'; dir: string; reason: string }
  | { status: 'read'; atlas: ForeignAtlas; warning?: string };

// Only the fields Fiu uses; every one optional, unknown ones ignored.
const text = z.string().trim().min(1);
const NodeSchema = z.object({
  id: text,
  type: text.optional(),
  name: text.optional(),
  filePath: text.optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const LayerSchema = z.object({ name: text, description: z.string().optional(), nodeIds: z.array(z.string()).optional() });
const TourStepSchema = z.object({ order: z.number().optional(), title: z.string().optional(), nodeIds: z.array(z.string()).optional() });
const GraphSchema = z.object({
  project: z.object({ description: z.string().optional(), gitCommitHash: z.string().optional(), analyzedAt: z.string().optional() }).optional().catch(undefined),
  nodes: z.array(z.unknown()).optional().catch(undefined),
  layers: z.array(z.unknown()).optional().catch(undefined),
  tour: z.array(z.unknown()).optional().catch(undefined),
});
type Node = z.infer<typeof NodeSchema>;

const CODE_TYPES = new Set(['file', 'function', 'class']);

/** The directory holding UA's graph, if any, relative to the repository root. */
export function findUaDir(repoRoot: string): string | undefined {
  return UA_DIRS.find((dir) => existsSync(join(repoRoot, dir, GRAPH_FILE)));
}

/** Read UA's graph from the repository, resolved against today's skeleton. Never throws for the graph's sake. */
export async function readForeignAtlas(repoRoot: string, skeleton: Skeleton): Promise<ForeignAtlasResult> {
  const dir = findUaDir(repoRoot);
  if (dir === undefined) return { status: 'absent' };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(repoRoot, dir, GRAPH_FILE), 'utf8'));
  } catch (error) {
    return { status: 'unreadable', dir, reason: error instanceof SyntaxError ? 'not valid JSON' : (error as Error).message };
  }
  const graph = GraphSchema.safeParse(raw);
  if (!graph.success || !graph.data.nodes) return { status: 'unreadable', dir, reason: 'no nodes list' };
  const commit = graph.data.project?.gitCommitHash?.trim() || undefined;
  const hashes = commit ? await blobHashesAt(repoRoot, commit) : undefined;
  return resolveGraph(graph.data, { dir, skeleton, ...(hashes ? { hashes } : {}) });
}

/**
 * The graph resolved against the skeleton: pure, so it can be tested on any graph. `hashes` are the blob
 * hashes of files at the commit UA analysed.
 */
export function resolveGraph(
  graph: z.infer<typeof GraphSchema>,
  { dir, skeleton, hashes }: { dir: string; skeleton: Skeleton; hashes?: Map<string, string> },
): ForeignAtlasResult {
  let skipped = 0;
  const parsed = <T>(schema: z.ZodType<T>, items: unknown[] | undefined): T[] =>
    (items ?? []).flatMap((item) => {
      const result = schema.safeParse(item);
      if (!result.success) skipped++;
      return result.success ? [result.data] : [];
    });
  const nodes = parsed(NodeSchema, graph.nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const files = new Map<string, ForeignFile>();
  const fileFor = (path: string): ForeignFile => {
    let file = files.get(path);
    if (!file) {
      const hash = hashes?.get(path);
      file = { path, ...(hash ? { hash } : {}), tags: [], functions: {} };
      files.set(path, file);
    }
    return file;
  };

  let codeNodes = 0;
  let matched = 0;
  for (const node of nodes) {
    const type = kindOf(node);
    if (!type || !CODE_TYPES.has(type)) continue;
    codeNodes++;
    const path = pathOf(node);
    const own = path === undefined ? undefined : skeleton.files.get(path);
    if (!own) continue;
    if (type === 'file') {
      matched++;
      const file = fileFor(own.path);
      const sentence = firstSentence(node.summary);
      if (sentence) file.text = sentence;
      file.tags = [...new Set([...file.tags, ...(node.tags ?? []).map((t) => t.trim()).filter(Boolean)])];
      continue;
    }
    const name = symbolOf(node, own);
    if (!name) continue;
    matched++;
    const sentence = firstSentence(node.summary);
    if (sentence) fileFor(own.path).functions[name] = sentence;
  }

  const filesOf = (ids: string[] | undefined): string[] => {
    const paths: string[] = [];
    for (const id of ids ?? []) {
      const node = byId.get(id);
      const path = node ? pathOf(node) : pathOfId(id);
      if (path !== undefined && skeleton.files.has(path) && !paths.includes(path)) paths.push(path);
    }
    return paths;
  };

  const layers: ForeignLayer[] = [];
  for (const layer of parsed(LayerSchema, graph.layers)) {
    const layerFiles = filesOf(layer.nodeIds);
    const description = firstSentence(layer.description);
    layers.push({ name: layer.name.trim(), ...(description ? { description } : {}), files: layerFiles });
    for (const path of layerFiles) fileFor(path).layer ??= layer.name.trim();
  }

  const tour = parsed(TourStepSchema, graph.tour)
    .map((step, index) => ({ order: step.order ?? index + 1, title: step.title?.trim() ?? '', files: filesOf(step.nodeIds) }))
    .filter((step) => step.files.length > 0)
    .sort((a, b) => a.order - b.order);

  const overview = firstSentence(graph.project?.description);
  const atlas: ForeignAtlas = {
    source: 'understand-anything',
    dir,
    ...(graph.project?.gitCommitHash?.trim() ? { commit: graph.project.gitCommitHash.trim() } : {}),
    ...(graph.project?.analyzedAt ? { analyzedAt: graph.project.analyzedAt } : {}),
    commitInClone: hashes !== undefined,
    ...(overview ? { overview } : {}),
    files,
    layers,
    tour,
    counts: { codeNodes, matched, skipped },
  };
  const warning =
    codeNodes >= MIN_NODES_TO_JUDGE && matched / codeNodes < MIN_MATCH_RATIO
      ? `only ${matched} of ${codeNodes} of its code entries match this code: its format may have changed`
      : undefined;
  return { status: 'read', atlas, ...(warning ? { warning } : {}) };
}

/** Current when the file is as UA analysed it; stale otherwise, or when the commit it analysed isn't here. */
export function foreignState(entry: ForeignFile | undefined, file: Pick<SkeletonFile, 'hash'>): EntryState {
  if (!entry) return 'missing';
  return entryState({ hash: entry.hash ?? '' }, file.hash);
}

/** A node's type: its `type`, else its ID's prefix (`function:src/a.ts:f`). */
const kindOf = (node: Node): string | undefined => node.type ?? node.id.split(':')[0];

/** A repository path as the skeleton writes it: `/`, no leading `./`. */
const normalise = (path: string) => path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');

const pathOf = (node: Node): string | undefined => (node.filePath ? normalise(node.filePath) : pathOfId(node.id));

/** The path in an ID: `file:<path>`, or `<kind>:<path>:<name>`. */
function pathOfId(id: string): string | undefined {
  const colon = id.indexOf(':');
  if (colon < 0) return undefined;
  const rest = id.slice(colon + 1);
  const kind = id.slice(0, colon);
  if (kind === 'file') return normalise(rest);
  const last = rest.lastIndexOf(':');
  return last > 0 ? normalise(rest.slice(0, last)) : undefined;
}

/**
 * The skeleton's name for a function or class node: its name as written, else the one symbol whose last
 * segment it is (`push` is `Queue.push` when no other `push` exists). Ambiguous or unknown names don't count.
 */
function symbolOf(node: Node, file: SkeletonFile): string | undefined {
  const candidates = [node.name, node.id.slice(node.id.lastIndexOf(':') + 1)].filter((n): n is string => Boolean(n?.trim())).map((n) => n.trim());
  for (const name of candidates) if (file.symbols.some((s) => s.name === name)) return name;
  for (const name of candidates) {
    const tail = name.split('.').pop()!;
    const found = file.symbols.filter((s) => s.name.split('.').pop() === tail);
    if (found.length === 1) return found[0]!.name;
  }
  return undefined;
}

/** The first sentence of a description, on one line, within the Atlas's length limit. */
export function firstSentence(text: string | undefined): string | undefined {
  const flat = text?.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length <= MAX_TEXT ? sentence : `${sentence.slice(0, MAX_TEXT - 1).replace(/\s+\S*$/, '')}…`;
}

/** Every file's blob hash at a commit, or undefined when the commit isn't in this clone. */
async function blobHashesAt(repoRoot: string, commit: string): Promise<Map<string, string> | undefined> {
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return undefined;
  try {
    const { stdout } = await execa('git', ['ls-tree', '-r', '-z', commit], { cwd: repoRoot });
    const hashes = new Map<string, string>();
    for (const line of stdout.split('\0')) {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (match) hashes.set(match[2]!, match[1]!);
    }
    return hashes;
  } catch {
    return undefined;
  }
}
