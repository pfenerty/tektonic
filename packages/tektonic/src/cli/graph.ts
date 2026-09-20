import type { GraphNode, PipelineGraph } from '../lib/core/tektonic-project';

/** One project's worth of graph, as written to the graph manifest by `TektonicProject`. */
export interface ProjectGraph {
  project?: string;
  outdir: string;
  pipelines: PipelineGraph[];
}

/** Groups tasks into dependency levels: level 0 has no `runAfter`, level N runs after level N-1. */
function levels(tasks: GraphNode[]): GraphNode[][] {
  const depth = new Map<string, number>();
  const byName = new Map(tasks.map(t => [t.name, t]));
  const depthOf = (task: GraphNode, seen: Set<string>): number => {
    const known = depth.get(task.name);
    if (known !== undefined) return known;
    // A cycle cannot reach here (Pipeline rejects one at build time), but a runAfter naming a
    // task outside this pipeline can, so unknown names simply contribute no depth.
    if (seen.has(task.name)) return 0;
    seen.add(task.name);
    const parents = task.runAfter.map(n => byName.get(n)).filter((t): t is GraphNode => !!t);
    const d = parents.length === 0 ? 0 : Math.max(...parents.map(p => depthOf(p, seen))) + 1;
    depth.set(task.name, d);
    return d;
  };
  for (const t of tasks) depthOf(t, new Set());
  const out: GraphNode[][] = [];
  for (const t of tasks) {
    const d = depth.get(t.name) ?? 0;
    (out[d] ??= []).push(t);
  }
  return out.map(level => level.sort((a, b) => a.name.localeCompare(b.name)));
}

/** Renders the DAG as indented text — one block per dependency level, `?` marking a gated task. */
export function renderText(graphs: ProjectGraph[]): string {
  const lines: string[] = [];
  for (const g of graphs) {
    for (const p of g.pipelines) {
      const events = p.events.length > 0 ? ` [${p.events.join(', ')}]` : '';
      const timeout = p.timeout ? ` timeout=${p.timeout}` : '';
      lines.push(`${p.name}${events}${timeout}`);
      const grouped = levels(p.tasks);
      grouped.forEach((level, i) => {
        lines.push(`  ${i === 0 ? 'first' : `after ${grouped[i - 1].map(t => t.name).join(', ')}`}:`);
        for (const t of level) lines.push(`    ${t.gated ? '?' : '-'} ${t.name}`);
      });
      if (p.finally.length > 0) {
        lines.push('  finally:');
        for (const t of p.finally) lines.push(`    - ${t.name}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd();
}

/** Sanitizes a task name into a mermaid node id. */
const nodeId = (pipeline: string, task: string): string =>
  `${pipeline}_${task}`.replace(/[^A-Za-z0-9_]/g, '_');

/** Renders the DAG as a mermaid flowchart, one subgraph per pipeline. */
export function renderMermaid(graphs: ProjectGraph[]): string {
  const lines = ['flowchart TD'];
  for (const g of graphs) {
    for (const p of g.pipelines) {
      lines.push(`  subgraph ${p.name.replace(/[^A-Za-z0-9_]/g, '_')}["${p.name}"]`);
      for (const t of p.tasks) {
        const id = nodeId(p.name, t.name);
        lines.push(`    ${id}${t.gated ? `{{"${t.name}"}}` : `["${t.name}"]`}`);
      }
      for (const t of p.tasks) {
        for (const dep of t.runAfter) {
          lines.push(`    ${nodeId(p.name, dep)} --> ${nodeId(p.name, t.name)}`);
        }
      }
      for (const t of p.finally) {
        lines.push(`    ${nodeId(p.name, t.name)}(["${t.name} (finally)"])`);
      }
      lines.push('  end');
    }
  }
  return lines.join('\n');
}
