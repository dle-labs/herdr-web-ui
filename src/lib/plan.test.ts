import { describe, expect, it } from "bun:test";

import type { PlanStep } from "../../shared/protocol.ts";
import { FLOW, flowLayout, planWaves } from "./plan.ts";

const step = (id: string, blocked_by: string[] = [], status: PlanStep["status"] = "pending"): PlanStep =>
  ({ id, label: `step ${id}`, active: null, status, blocked_by, owner: null, started_at: null, ended_at: null });

describe("planWaves", () => {
  it("puts a step one wave after the last step it waits on, keeping the plan's order inside a wave", () => {
    const waves = planWaves([step("1"), step("2", ["1"]), step("3", ["1"]), step("4", ["2", "3"]), step("5")]);
    expect(waves.map((wave) => wave.map((s) => s.id))).toEqual([["1", "5"], ["2", "3"], ["4"]]);
  });

  it("ignores a wait on a step that is gone and does not follow a loop", () => {
    expect(planWaves([step("1", ["9"]), step("2", ["3"]), step("3", ["2"])]).flat().map((s) => s.id).sort()).toEqual(["1", "2", "3"]);
  });
});

describe("flowLayout", () => {
  it("centres each wave and draws a curve from each step waited on, open once that step is done", () => {
    const layout = flowLayout([step("1", [], "completed"), step("2", ["1"]), step("3", ["1"]), step("4", ["2", "3"])]);
    const { nodeWidth, nodeHeight, columnGap, rowGap, pad } = FLOW;
    expect(layout.width).toBe(pad * 2 + 2 * nodeWidth + columnGap);
    expect(layout.height).toBe(pad * 2 + 3 * nodeHeight + 2 * rowGap);
    const one = layout.nodes.find((node) => node.step.id === "1")!;
    expect(one.x).toBe((layout.width - nodeWidth) / 2);
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}:${edge.done}`)).toEqual(["1>2:true", "1>3:true", "2>4:false", "3>4:false"]);
    expect(layout.edges[0]!.path.startsWith(`M ${one.x + nodeWidth / 2} ${one.y + nodeHeight} C`)).toBe(true);
  });

  it("wraps a wave wider than the columns it may take onto more rows, with no curve between them", () => {
    const layout = flowLayout([step("1"), step("2"), step("3"), step("4"), step("5", ["1"])], 2);
    const { nodeWidth, nodeHeight, columnGap, rowGap, pad } = FLOW;
    expect(layout.width).toBe(pad * 2 + 2 * nodeWidth + columnGap);
    expect(layout.nodes.map((node) => `${node.step.id}@${(node.y - pad) / (nodeHeight + rowGap)}`)).toEqual(["1@0", "2@0", "3@1", "4@1", "5@2"]);
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(["1>5"]);
  });

  it("lays out an empty plan as one empty column", () => {
    expect(flowLayout([])).toMatchObject({ nodes: [], edges: [] });
  });
});
