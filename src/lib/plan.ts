import type { PlanStep } from "../../shared/protocol.ts";

/**
 * A plan's steps by wave: a step comes one wave after the last of the steps it waits on, so a
 * wave's steps can run side by side. Order inside a wave is the plan's own. A wait that loops
 * back is not followed.
 */
export function planWaves(steps: readonly PlanStep[]): PlanStep[][] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (step: PlanStep): number => {
    const known = level.get(step.id);
    if (known !== undefined) return known;
    if (visiting.has(step.id)) return 0;
    visiting.add(step.id);
    let wave = 0;
    for (const id of step.blocked_by) {
      const before = byId.get(id);
      if (before !== undefined) wave = Math.max(wave, depth(before) + 1);
    }
    visiting.delete(step.id);
    level.set(step.id, wave);
    return wave;
  };
  const waves: PlanStep[][] = [];
  for (const step of steps) (waves[depth(step)] ??= []).push(step);
  return waves.filter((wave) => wave !== undefined);
}

export const FLOW = { nodeWidth: 156, nodeHeight: 58, columnGap: 16, rowGap: 34, pad: 6 } as const;

export interface FlowLayout {
  width: number;
  height: number;
  nodes: { step: PlanStep; x: number; y: number }[];
  /** `done`: the step it comes from is done, so the way on is open */
  edges: { from: string; to: string; path: string; done: boolean }[];
}

/**
 * Where each step's box goes (waves top to bottom, each wave centred, a wave wider than
 * `maxColumns` wrapped onto more rows) and the curve from each step it waits on.
 */
export function flowLayout(steps: readonly PlanStep[], maxColumns = 4): FlowLayout {
  const { nodeWidth, nodeHeight, columnGap, rowGap, pad } = FLOW;
  const waves = planWaves(steps).flatMap((wave) => Array.from({ length: Math.ceil(wave.length / maxColumns) }, (_, row) => wave.slice(row * maxColumns, (row + 1) * maxColumns)));
  const columns = Math.max(1, ...waves.map((wave) => wave.length));
  const width = pad * 2 + columns * nodeWidth + (columns - 1) * columnGap;
  const height = pad * 2 + waves.length * nodeHeight + Math.max(0, waves.length - 1) * rowGap;
  const nodes = waves.flatMap((wave, row) => {
    const left = (width - (wave.length * nodeWidth + (wave.length - 1) * columnGap)) / 2;
    return wave.map((step, column) => ({ step, x: left + column * (nodeWidth + columnGap), y: pad + row * (nodeHeight + rowGap) }));
  });
  const at = new Map(nodes.map((node) => [node.step.id, node]));
  const edges = nodes.flatMap(({ step, x, y }) => step.blocked_by.flatMap((id) => {
    const from = at.get(id);
    if (from === undefined || from.y >= y) return [];
    const x1 = from.x + nodeWidth / 2;
    const y1 = from.y + nodeHeight;
    const x2 = x + nodeWidth / 2;
    const bend = Math.max(rowGap * 0.6, (y - y1) / 2);
    return [{ from: id, to: step.id, path: `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y - bend}, ${x2} ${y}`, done: from.step.status === "completed" }];
  }));
  return { width, height, nodes, edges };
}
