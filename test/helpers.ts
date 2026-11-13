import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { execa } from 'execa';

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fiu-test-'));
  after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function tempGitRepo(): Promise<string> {
  const dir = await tempDir();
  await execa('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/**
 * Understand-Anything's graphs in a repository, as `/understand` and `/understand-domain` write them,
 * analysed at HEAD: one domain holding these flows, each step in order.
 */
export async function writeUaFlows(
  repo: string,
  flows: { name: string; domain?: string; entry?: string; steps: { name: string; path?: string; lineRange?: [number, number] }[] }[],
): Promise<void> {
  const { mkdir: mkdirp, writeFile: write } = await import('node:fs/promises');
  const commit = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  for (const flow of flows) {
    const domain = `domain:${slug(flow.domain ?? 'core')}`;
    if (!nodes.some((n) => (n as { id: string }).id === domain)) nodes.push({ id: domain, type: 'domain', name: flow.domain ?? 'Core', summary: '', tags: [], complexity: 'simple' });
    const id = `flow:${slug(flow.name)}`;
    nodes.push({ id, type: 'flow', name: flow.name, summary: '', tags: [], complexity: 'simple', ...(flow.entry ? { domainMeta: { entryPoint: flow.entry, entryType: 'cli' } } : {}) });
    edges.push({ source: domain, target: id, type: 'contains_flow', direction: 'forward', weight: 1 });
    flow.steps.forEach((step, i) => {
      const stepId = `step:${slug(flow.name)}:${slug(step.name)}`;
      nodes.push({ id: stepId, type: 'step', name: step.name, ...(step.path ? { filePath: step.path } : {}), ...(step.lineRange ? { lineRange: step.lineRange } : {}), summary: '', tags: [], complexity: 'simple' });
      edges.push({ source: id, target: stepId, type: 'flow_step', direction: 'forward', weight: Math.round(((i + 1) / flow.steps.length) * 100) / 100 });
    });
  }
  await mkdirp(join(repo, '.ua'), { recursive: true });
  await write(join(repo, '.ua', 'knowledge-graph.json'), JSON.stringify({ version: '1.0.0', project: { gitCommitHash: commit }, nodes: [], edges: [] }));
  await write(join(repo, '.ua', 'domain-graph.json'), JSON.stringify({ version: '1.0.0', project: { gitCommitHash: commit }, nodes, edges }));
}
