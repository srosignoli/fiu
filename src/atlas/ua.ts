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
/** Written by UA's `/understand-domain`: business domains, flows, and their ordered steps. Optional. */
const DOMAIN_FILE = 'domain-graph.json';

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
  /** Business flows from `domain-graph.json`, steps in order; empty when there is none. */
  flows: ForeignFlow[];
  /** Business rules from `domain-graph.json`; empty when there is none. */
  rules: ForeignRule[];
}

/**
 * A business rule as UA wrote it ("Background Workouts past their expiry are discarded"): a claim about
 * the system, the model's word. A Prediction about it measures whether the code agrees.
 */
export interface ForeignRule {
  text: string;
  domain?: string;
  /** The flow or step it was written on, when not on a whole domain. */
  flow?: string;
  /** Where the rule should be enforced: the files of the steps of its flow, or of every flow of its domain. */
  files: string[];
}

/** One step of a flow: where it runs, when UA's path is a file of the skeleton. */
export interface ForeignStep {
  name: string;
  path?: string;
  /** 1-based, inclusive, at the commit UA analysed. */
  lineRange?: [number, number];
  /** The file is as it was at that commit, so the line range still holds. */
  current: boolean;
}

/** A business flow: what starts it, its domain, and its steps in order. */
export interface ForeignFlow {
  name: string;
  domain?: string;
  /** What starts the flow, as UA wrote it (`fiu drill <path>`, `POST /orders`). */
  entry?: string;
  steps: ForeignStep[];
}

/** Where a flow passes through some code: the step, and whether it is that code or only its file. */
export interface FlowMatch {
  flow: ForeignFlow;
  /** 0-based index of the step in the flow. */
  index: number;
  /** `code`: the step's lines overlap the code; `file`: the step is elsewhere in the same file, or the file changed since. */
  where: 'code' | 'file';
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

const DomainNodeSchema = z.object({
  id: text,
  type: text,
  name: text,
  filePath: text.optional(),
  lineRange: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional().catch(undefined),
  domainMeta: z.object({ entryPoint: z.string().optional(), businessRules: z.array(z.string()).optional().catch(undefined) }).optional().catch(undefined),
});
const DomainEdgeSchema = z.object({ source: text, target: text, type: text, weight: z.number().optional().catch(undefined) });
const DomainGraphSchema = z.object({
  project: z.object({ gitCommitHash: z.string().optional() }).optional().catch(undefined),
  nodes: z.array(z.unknown()).optional().catch(undefined),
  edges: z.array(z.unknown()).optional().catch(undefined),
});

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
  const result = resolveGraph(graph.data, { dir, skeleton, ...(hashes ? { hashes } : {}) });
  if (result.status === 'read') Object.assign(result.atlas, await readDomain(repoRoot, dir, skeleton, commit, hashes));
  return result;
}

/** The domain graph's flows and rules, or none when it is absent or unreadable: an extra, never a failure. */
async function readDomain(
  repoRoot: string,
  dir: string,
  skeleton: Skeleton,
  graphCommit: string | undefined,
  graphHashes: Map<string, string> | undefined,
): Promise<{ flows: ForeignFlow[]; rules: ForeignRule[] }> {
  const none = { flows: [], rules: [] };
  const path = join(repoRoot, dir, DOMAIN_FILE);
  if (!existsSync(path)) return none;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return none;
  }
  const graph = DomainGraphSchema.safeParse(raw);
  if (!graph.success) return none;
  const commit = graph.data.project?.gitCommitHash?.trim() || graphCommit;
  const hashes = commit === graphCommit ? graphHashes : commit ? await blobHashesAt(repoRoot, commit) : undefined;
  const flows = resolveFlows(graph.data, { skeleton, ...(hashes ? { hashes } : {}) });
  return { flows, rules: resolveRules(graph.data, flows) };
}

/**
 * Pure: every business rule, on a domain, a flow, or a step, with the files where it should hold: a
 * step's file, its flow's files, or the files of every flow of its domain. Files the skeleton lacks are left out.
 */
export function resolveRules(graph: z.infer<typeof DomainGraphSchema>, flows: ForeignFlow[]): ForeignRule[] {
  const nodes = new Map((graph.nodes ?? []).flatMap((item) => {
    const node = DomainNodeSchema.safeParse(item);
    return node.success ? [[node.data.id, node.data] as const] : [];
  }));
  const edges = (graph.edges ?? []).flatMap((item) => {
    const edge = DomainEdgeSchema.safeParse(item);
    return edge.success ? [edge.data] : [];
  });
  const flowsByName = new Map(flows.map((flow) => [flow.name, flow]));
  const filesOf = (flow: ForeignFlow | undefined) => [...new Set((flow?.steps ?? []).flatMap((s) => (s.path ? [s.path] : [])))];
  const parentOf = (id: string, type: string) => edges.map((e) => (e.target === id ? nodes.get(e.source) : undefined)).find((n) => n?.type === type);
  const rules: ForeignRule[] = [];
  for (const node of nodes.values()) {
    const texts = (node.domainMeta?.businessRules ?? []).map((t) => t.trim()).filter(Boolean);
    if (texts.length === 0) continue;
    let domain: string | undefined;
    let flowName: string | undefined;
    let files: string[];
    if (node.type === 'domain') {
      domain = node.name.trim();
      const owned = edges.filter((e) => e.type === 'contains_flow' && e.source === node.id).map((e) => nodes.get(e.target)?.name.trim());
      files = [...new Set(owned.flatMap((name) => filesOf(name ? flowsByName.get(name) : undefined)))];
    } else if (node.type === 'flow') {
      flowName = node.name.trim();
      domain = parentOf(node.id, 'domain')?.name.trim();
      files = filesOf(flowsByName.get(flowName));
    } else if (node.type === 'step') {
      const flow = parentOf(node.id, 'flow');
      flowName = flow?.name.trim();
      domain = flow ? parentOf(flow.id, 'domain')?.name.trim() : undefined;
      const path = node.filePath ? normalise(node.filePath) : undefined;
      files = path !== undefined && flows.some((f) => f.steps.some((s) => s.path === path)) ? [path] : [];
    } else continue;
    for (const text of texts) rules.push({ text, ...(domain ? { domain } : {}), ...(flowName ? { flow: flowName } : {}), files });
  }
  return rules;
}

/**
 * Pure: the flows of a domain graph, each step in order (by its `flow_step` edge's weight, ties in the
 * order written), with its domain and what starts it. A step keeps its path only when the skeleton has
 * that file, and is current when the file is unchanged since the commit UA analysed.
 */
export function resolveFlows(graph: z.infer<typeof DomainGraphSchema>, { skeleton, hashes }: { skeleton: Skeleton; hashes?: Map<string, string> }): ForeignFlow[] {
  const parse = <T>(schema: z.ZodType<T>, items: unknown[] | undefined): T[] => (items ?? []).flatMap((item) => (schema.safeParse(item).success ? [schema.parse(item)] : []));
  const nodes = new Map(parse(DomainNodeSchema, graph.nodes).map((node) => [node.id, node]));
  const edges = parse(DomainEdgeSchema, graph.edges);
  const flows: ForeignFlow[] = [];
  for (const flow of nodes.values()) {
    if (flow.type !== 'flow') continue;
    const domain = edges.map((e) => (e.type === 'contains_flow' && e.target === flow.id ? nodes.get(e.source) : undefined)).find((n) => n?.type === 'domain');
    const steps = edges
      .map((edge, order) => ({ edge, order }))
      .filter(({ edge }) => edge.type === 'flow_step' && edge.source === flow.id && nodes.get(edge.target)?.type === 'step')
      .sort((a, b) => (a.edge.weight ?? 0) - (b.edge.weight ?? 0) || a.order - b.order)
      .map(({ edge }): ForeignStep => {
        const step = nodes.get(edge.target)!;
        const path = step.filePath ? normalise(step.filePath) : undefined;
        const file = path === undefined ? undefined : skeleton.files.get(path);
        const range = step.lineRange && step.lineRange[0] <= step.lineRange[1] ? step.lineRange : undefined;
        return { name: step.name.trim(), ...(file ? { path: file.path } : {}), ...(file && range ? { lineRange: range } : {}), current: file !== undefined && hashes?.get(file.path) === file.hash };
      });
    if (steps.length === 0) continue;
    const entry = flow.domainMeta?.entryPoint?.trim();
    flows.push({ name: flow.name.trim(), ...(domain ? { domain: domain.name.trim() } : {}), ...(entry ? { entry } : {}), steps });
  }
  return flows;
}

/**
 * Where flows pass through some code of a file: the steps whose lines overlap `ranges` (today's lines of
 * the target), when the file is unchanged since UA analysed it; otherwise a step elsewhere in the file.
 * Overlapping steps first, at most one match per flow.
 */
export function flowsThrough(flows: ForeignFlow[], path: string, ranges: { startLine: number; endLine: number }[]): FlowMatch[] {
  const matches: FlowMatch[] = [];
  for (const flow of flows) {
    const inFile = flow.steps.map((step, index) => ({ step, index })).filter(({ step }) => step.path === path);
    if (inFile.length === 0) continue;
    const overlapping = inFile.find(({ step }) => step.current && step.lineRange && ranges.some((r) => step.lineRange![0] <= r.endLine && step.lineRange![1] >= r.startLine));
    matches.push(overlapping ? { flow, index: overlapping.index, where: 'code' } : { flow, index: inFile[0]!.index, where: 'file' });
  }
  return matches.sort((a, b) => Number(a.where === 'file') - Number(b.where === 'file'));
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
    flows: [],
    rules: [],
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
  if (sentence.length <= MAX_TEXT) return sentence;
  // Too long: end at the last clause that fits (a comma, semicolon, colon, or dash), else at a word.
  const room = sentence.slice(0, MAX_TEXT - 1);
  const balanced = (end: number) => (room.slice(0, end).match(/[([{]/g) ?? []).length === (room.slice(0, end).match(/[)\]}]/g) ?? []).length;
  for (let end = room.length; end >= MIN_CLAUSE; end--) {
    if (/^(, |; |: | — | - )/.test(room.slice(end)) && balanced(end)) return `${room.slice(0, end)}…`;
  }
  return `${room.replace(/\s+\S*$/, '')}…`;
}

/** A clause shorter than this says too little to stand for the sentence: cut at a word instead. */
const MIN_CLAUSE = 80;

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
