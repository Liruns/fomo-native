// @vitest-environment jsdom
import {
  deriveAgentPanelModel,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AgentsPanel } from "./AgentsPanel";

function agent(id: string, overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    title: id,
    role: null,
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-09-28T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

const direct = agent("direct-agent", { status: "idle", usage: { totalTokens: 111 } });
const coordinator = agent("dag-run", {
  kind: "workflow",
  workflowName: "dag-workflow",
  phases: [{ index: 0, title: "phase-build" }],
  usage: { totalTokens: 999 },
});
const member = agent("dag-member", {
  kind: "workflow_agent",
  parentAgentId: coordinator.id,
  phaseIndex: 0,
  usage: { totalTokens: 222 },
  progress: "progress-sentinel",
});
const unphasedMember = agent("dag-unphased", {
  kind: "workflow_agent",
  parentAgentId: coordinator.id,
  status: "completed",
  usage: { totalTokens: 333 },
});
const mixedAgents = [direct, coordinator, member, unphasedMember];

let root: Root;
let container: HTMLDivElement;
let restoreAnimations: () => void;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  restoreAnimations = () => {
    if (originalGetAnimations)
      Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
  };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreAnimations();
  vi.unstubAllGlobals();
});

async function render(mode: "agents" | "workflow", agents: readonly RuntimeSubagent[]) {
  await act(async () => {
    root.render(<AgentsPanel mode={mode} model={deriveAgentPanelModel({ agents })} />);
  });
}

function footerCounts() {
  return container.querySelector("footer")?.textContent?.match(/\d+/g)?.map(Number);
}

function disclosure() {
  return container.querySelector<HTMLButtonElement>("section button[aria-expanded]")!;
}

describe("AgentsPanel surface modes", () => {
  it("shows only direct agents and their usage in Agents, even when workflows exist", async () => {
    await render("agents", mixedAgents);
    expect(container.textContent).toContain(direct.title);
    expect(container.textContent).not.toContain(coordinator.workflowName);
    expect(container.textContent).not.toContain(member.title);
    expect(container.textContent).not.toContain(unphasedMember.title);
    expect(footerCounts()).toEqual([1, 111]);
  });

  it("shows only workflow groups and counts members without coordinator double-counting", async () => {
    await render("workflow", mixedAgents);
    expect(container.textContent).not.toContain(direct.title);
    expect(container.textContent).toContain(coordinator.workflowName);
    expect(container.textContent).toContain(member.title);
    expect(container.textContent).toContain(member.progress);
    expect(container.textContent).toContain(unphasedMember.title);
    expect(footerCounts()).toEqual([1, 1, 555]);
  });

  it.each([
    { mode: "agents" as const, agents: [coordinator, member] },
    { mode: "workflow" as const, agents: [direct] },
    { mode: "agents" as const, agents: [] },
    { mode: "workflow" as const, agents: [] },
  ])(
    "shows an empty state for $mode when only the other surface has data",
    async ({ mode, agents }) => {
      await render(mode, agents);
      expect(container.querySelector('[role="status"]')).not.toBeNull();
      expect(container.querySelector("section")).toBeNull();
      expect(container.querySelector("footer")).toBeNull();
    },
  );

  it("counts a workflow coordinator when its members have not arrived", async () => {
    await render("workflow", [direct, coordinator]);
    expect(container.textContent).toContain(coordinator.workflowName);
    expect(container.textContent).not.toContain(direct.title);
    expect(footerCounts()).toEqual([1, 999]);
  });

  it("updates a live workflow in place and keeps its phase expanded when it completes", async () => {
    await render("workflow", mixedAgents);
    const row = [...container.querySelectorAll("span")].find(
      (node) => node.textContent === member.title,
    );
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");
    await render("workflow", [
      direct,
      { ...coordinator, status: "completed" },
      { ...member, status: "completed", result: "result-sentinel", usage: { totalTokens: 444 } },
      unphasedMember,
    ]);
    expect(row?.isConnected).toBe(true);
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("result-sentinel");
    expect(footerCounts()).toEqual([2, 777]);
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "opens a historical %s workflow and shows its saved member result",
    async (status) => {
      const result = `${status}-result-sentinel`;
      await render("workflow", [direct, { ...coordinator, status }, { ...member, status, result }]);
      expect(disclosure().getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).not.toContain(member.title);
      await act(async () => disclosure().click());
      expect(container.textContent).toContain(member.title);
      expect(container.textContent).toContain(result);
      expect(container.textContent).not.toContain(direct.title);
      expect(footerCounts()).toEqual([1, 222]);
    },
  );
});
