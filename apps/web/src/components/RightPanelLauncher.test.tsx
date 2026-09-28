// @vitest-environment jsdom
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { emptyAgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/browser/browserDefaults", () => ({
  useBrowserDefaults: () => ({ profiles: [] }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

import { RightPanelTabs } from "./RightPanelTabs";
import { AgentsPanel } from "./AgentsPanel";
import { dismissContextMenu } from "../contextMenuFallback";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("workflow-env"),
  ThreadId.make("workflow-thread"),
);

function WorkflowPanelHarness() {
  const store = useRightPanelStore();
  const state = selectThreadRightPanelState(store.byThreadKey, threadRef);
  const activeSurface = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
  return (
    <RightPanelTabs
      {...props}
      surfaces={state.surfaces}
      activeSurfaceId={state.activeSurfaceId}
      workflowAvailable
      onAddWorkflow={() => store.open(threadRef, "workflow")}
      onAddAgents={() => store.open(threadRef, "agents")}
      onActivate={(surface) => store.activateSurface(threadRef, surface.id)}
      onCloseSurface={(surface) => store.closeSurface(threadRef, surface.id)}
      onCloseOtherSurfaces={(surface) => store.closeOtherSurfaces(threadRef, surface.id)}
      onCloseSurfacesToRight={(surface) => store.closeSurfacesToRight(threadRef, surface.id)}
      onCloseAllSurfaces={() => store.closeAllSurfaces(threadRef)}
    >
      {activeSurface?.kind === "workflow" || activeSurface?.kind === "agents" ? (
        <AgentsPanel mode={activeSurface.kind} model={emptyAgentPanelModel()} />
      ) : null}
    </RightPanelTabs>
  );
}

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof RightPanelTabs>;
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
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
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
  props = {
    mode: "embedded",
    surfaces: [],
    environmentId: null,
    activeSurfaceId: null,
    pendingSurfaceIds: new Set(),
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map(),
    liveAgentCount: 0,
    children: null,
    browserAvailable: false,
    terminalAvailable: true,
    filesAvailable: true,
    diffAvailable: false,
    pullRequestAvailable: false,
    pullRequestsAvailable: false,
    agentsAvailable: true,
    deviceAvailable: true,
    onActivate: vi.fn(),
    onCloseSurface: vi.fn(),
    onCloseOtherSurfaces: vi.fn(),
    onCloseSurfacesToRight: vi.fn(),
    onCloseAllSurfaces: vi.fn(),
    onCopyFilePath: vi.fn(),
    onAddBrowser: vi.fn(),
    onAddBrowserInProfile: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddDiff: vi.fn(),
    onAddFiles: vi.fn(),
    onAddPullRequest: vi.fn(),
    onAddPullRequests: vi.fn(),
    onAddAgents: vi.fn(),
    onAddDevice: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dismissContextMenu();
  restoreAnimations();
  vi.unstubAllGlobals();
});

const card = (key: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-keyshortcuts="${key}"]`)!;
const press = async (key: string, target: Element | Window = window) => {
  await act(async () =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
  );
};
const render = async () => {
  await act(async () => root.render(<RightPanelTabs {...props} />));
};

describe("surface launcher interaction", () => {
  it.each(["inline", "sheet"] as const)(
    "opens, closes, and reopens Workflow by card and W in %s mode",
    async (mode) => {
      props.mode = mode;
      await act(async () => root.render(<WorkflowPanelHarness />));
      await act(async () => card("W").click());
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef)
          .activeSurfaceId,
      ).toBe("workflow");
      expect(
        container.querySelector('[data-active-tab="true"] svg.lucide-workflow'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-right-panel-surface-content] [role="status"]'),
      ).not.toBeNull();
      await act(async () =>
        container.querySelector<HTMLButtonElement>('button[aria-label="Close Workflow"]')!.click(),
      );
      await press("w");
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
      ).toEqual([{ id: "workflow", kind: "workflow" }]);

      // The native-menu fallback arms click dismissal on its first animation frame.
      // Drive that exact frame instead of racing a real timer or sleeping.
      const menuFrames: FrameRequestCallback[] = [];
      const requestFrame = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback) => {
          menuFrames.push(callback);
          return menuFrames.length;
        });
      try {
        await act(async () => {
          container
            .querySelector('[data-active-tab="true"]')!
            .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
          for (const frame of menuFrames) frame(0);
        });
      } finally {
        requestFrame.mockRestore();
      }
      const close = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Close",
      )!;
      await act(async () => close.click());
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
      ).toHaveLength(0);
      expect(card("W")).not.toBeNull();
    },
  );

  it.each(["click", "key"])(
    "adds Workflow beside Agents from the add menu by %s",
    async (action) => {
      useRightPanelStore.getState().open(threadRef, "agents");
      await act(async () => root.render(<WorkflowPanelHarness />));
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Add panel surface"]')!
          .click(),
      );
      const item = document.querySelector<HTMLElement>('[role="menuitem"][aria-keyshortcuts="W"]')!;
      expect(item).not.toBeNull();
      if (action === "click") await act(async () => item.click());
      else await press("W", item);
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
      ).toMatchObject({
        activeSurfaceId: "workflow",
        surfaces: [
          { id: "agents", kind: "agents" },
          { id: "workflow", kind: "workflow" },
        ],
      });
    },
  );

  it("leaves Workflow shortcuts alone inside an editor or an overlay", async () => {
    props.workflowAvailable = true;
    props.onAddWorkflow = vi.fn();
    await render();
    const input = document.createElement("textarea");
    container.append(input);
    await press("w", input);
    const menu = document.createElement("div");
    menu.dataset.slot = "menu-popup";
    container.append(menu);
    await press("w");
    expect(props.onAddWorkflow).not.toHaveBeenCalled();
    menu.remove();
    await press("W");
    expect(props.onAddWorkflow).toHaveBeenCalledOnce();
  });

  it("requires both workflow wiring fields for click and keyboard activation", async () => {
    props.onAddWorkflow = vi.fn();
    await render();
    expect(card("W").getAttribute("aria-disabled")).toBe("true");
    await act(async () => card("W").click());
    await press("w");
    expect(props.onAddWorkflow).not.toHaveBeenCalled();

    props.workflowAvailable = true;
    await render();
    await act(async () => card("W").click());
    await press("w");
    expect(props.onAddWorkflow).toHaveBeenCalledTimes(2);

    props.onAddWorkflow = undefined;
    await render();
    expect(card("W").getAttribute("aria-disabled")).toBe("true");
  });

  it("preserves existing actions, availability, and typing/modal shortcut guards", async () => {
    await render();
    await press("b");
    expect(props.onAddBrowser).not.toHaveBeenCalled();
    for (const [key, action] of [
      ["T", props.onAddTerminal],
      ["F", props.onAddFiles],
      ["A", props.onAddAgents],
      ["M", props.onAddDevice],
    ] as const) {
      await act(async () => card(key).click());
      await press(key.toLowerCase());
      expect(action).toHaveBeenCalledTimes(2);
    }
    const input = document.createElement("input");
    container.append(input);
    await press("t", input);
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    container.append(editor);
    await press("t", editor);
    const dialog = document.createElement("div");
    dialog.dataset.slot = "dialog-popup";
    container.append(dialog);
    await press("t");
    expect(props.onAddTerminal).toHaveBeenCalledTimes(2);
  });
});
