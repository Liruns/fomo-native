import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  collectTurn,
  completed,
  fixture,
  open,
  run,
  start,
  threadId,
} from "./OmoRpcTestFixture.ts";
import { ProviderRuntimeEvent } from "@t3tools/contracts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { foldSubagentActivities } from "../../../../../packages/client-runtime/src/state/subagentRuntime.ts";
import * as Schema from "effect/Schema";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";

describe("OmoRpcAdapter", () => {
  it("routes only the current thread's MCP credential through session context", () =>
    run(
      Effect.gen(function* () {
        // Given
        McpProviderSession.setMcpProviderSession({
          environmentId: "environment-test" as never,
          threadId,
          providerSessionId: "provider-session-test",
          providerInstanceId: "omo" as never,
          endpoint: "http://127.0.0.1:4100/mcp",
          authorizationHeader: "Bearer thread-secret",
          capabilities: new Set(["preview"]),
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
        );
        const adapter = yield* fixture([
          {
            expect: {
              type: "open_session",
              context: { t3_mcp_key: "00000000-0000-4000-8000-000000000001" },
            },
            data: open.data,
          },
        ]);
        // When / Then
        yield* adapter.startSession(start);
      }),
    ));

  it("streams text and reasoning until the complete agent run settles", () =>
    run(
      Effect.gen(function* () {
        // Given
        const adapter = yield* fixture([
          open,
          {
            expect: { type: "prompt", sessionId: "rpc-1", message: "hello" },
            data: { disposition: "started" },
            events: [
              { type: "agent_start" },
              { type: "turn_start" },
              {
                type: "message_update",
                assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
              },
              {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "PONG\u2028ok" },
              },
              { type: "turn_end", message: { role: "assistant", stopReason: "toolUse" } },
              { type: "agent_end", willRetry: true },
              { type: "agent_start" },
              { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "!" } },
              ...completed,
            ],
          },
        ]);
        yield* adapter.startSession(start);
        const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
        // When
        const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
        const received = yield* Fiber.join(events);
        // Then
        for (const event of received) yield* Schema.decodeEffect(ProviderRuntimeEvent)(event);
        expect(
          received.filter((event) => event.type === "content.delta").map((event) => event.payload),
        ).toEqual([
          { streamKind: "reasoning_text", delta: "thinking" },
          { streamKind: "assistant_text", delta: "PONG\u2028ok" },
          { streamKind: "assistant_text", delta: "!" },
        ]);
        expect(
          received
            .filter((event) => event.type === "turn.completed")
            .map((event) => [event.turnId, event.payload.state]),
        ).toEqual([[turn.turnId, "completed"]]);
      }),
    ));

  it.each(["completed", "failed", "cancelled"])(
    "emits task terminal status %s with the native identity and model",
    (status) =>
      run(
        Effect.gen(function* () {
          // Given
          const details = {
            task_id: "st-child",
            task_summary: "Inspect code",
            resolved_model: { display: "Model Large" },
            progress: { startedAt: 1_790_000_000_000 },
            run_stats: {
              input_tokens: 700,
              cache_read_tokens: 200,
              output_tokens: 100,
              total_tokens: 1_000,
              tool_calls: 3,
              runtime_ms: 4_000,
            },
          };
          const adapter = yield* fixture([
            open,
            {
              expect: { type: "prompt" },
              events: [
                {
                  type: "tool_execution_start",
                  toolName: "task",
                  toolCallId: "call-1",
                  args: { prompt: "inspect" },
                },
                {
                  type: "tool_execution_update",
                  toolName: "task",
                  toolCallId: "call-1",
                  partialResult: { details: { ...details, status: "running" } },
                },
                {
                  type: "tool_execution_end",
                  toolName: "task",
                  toolCallId: "call-1",
                  result: { details: { ...details, status } },
                  isError: false,
                },
                ...completed,
              ],
            },
          ]);
          yield* adapter.startSession(start);
          const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
          // When
          yield* adapter.sendTurn({ threadId, input: "delegate" });
          const received = yield* Fiber.join(events);
          // Then
          expect(
            received.filter((event) => event.type.startsWith("task.")).map((event) => event.type),
          ).toEqual(["task.started", "task.progress", "task.completed"]);
          expect(received.find((event) => event.type === "task.completed")?.payload).toMatchObject({
            taskId: "st-child",
            status: status === "cancelled" ? "stopped" : status,
            typedUsage: {
              totalTokens: 1_000,
              inputTokens: 700,
              cachedInputTokens: 200,
              outputTokens: 100,
              toolUses: 3,
              durationMs: 4_000,
            },
          });
          expect(received.find((event) => event.type === "task.progress")?.payload).toMatchObject({
            taskId: "st-child",
            description: "Inspect code",
            summary: "Model Large - Inspect code",
          });
        }),
      ),
  );

  it("maps background task snapshots and task controls onto one persisted agent identity", () =>
    run(
      Effect.gen(function* () {
        const adapter = yield* fixture([
          open,
          {
            expect: { type: "prompt" },
            events: [
              { type: "agent_start" },
              {
                type: "tool_execution_end",
                toolName: "task",
                toolCallId: "spawn",
                result: {
                  details: {
                    task_id: "st-bg",
                    task_summary: "Background audit",
                    name: "audit",
                    status: "running",
                    run_in_background: true,
                    resolved_model: { display: "Fast Model" },
                    progress: { activity: "Reading files", startedAt: 1_790_000_000_000 },
                  },
                },
              },
              {
                type: "extension_event",
                name: "omo.task.updated",
                data: {
                  tasks: [
                    {
                      task_id: "st-bg",
                      task_summary: "Background audit",
                      name: "audit",
                      status: "running",
                      updated_at: "2026-09-28T10:01:00.000Z",
                      run_stats: {
                        input_tokens: 40,
                        cache_read_tokens: 50,
                        output_tokens: 10,
                        total_tokens: 100,
                        tool_calls: 2,
                        runtime_ms: 5_000,
                      },
                      live_progress: { activity: "Running tests" },
                    },
                  ],
                },
              },
              {
                type: "tool_execution_end",
                toolName: "task_send",
                toolCallId: "send",
                args: { to: "audit", message: "include types" },
                result: { details: { kind: "delivered" } },
              },
              {
                type: "tool_execution_end",
                toolName: "task_cancel",
                toolCallId: "cancel",
                args: { name: "audit" },
                result: {
                  details: {
                    kind: "cancelled",
                    task_id: "st-bg",
                    status: "cancelled",
                  },
                },
              },
              ...completed,
            ],
          },
        ]);
        yield* adapter.startSession(start);
        const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
        yield* adapter.sendTurn({ threadId, input: "delegate" });
        const received = yield* Fiber.join(events);
        const tasks = received.filter((event) => event.type.startsWith("task."));
        expect(tasks.filter((event) => event.type === "task.started")).toHaveLength(1);
        expect(tasks.at(-1)?.payload).toMatchObject({
          taskId: "st-bg",
          taskType: "subagent",
          model: "Fast Model",
          status: "stopped",
        });
        const activities = tasks.flatMap((event) => runtimeEventToActivities(event));
        const [agent] = foldSubagentActivities(activities);
        expect(agent).toMatchObject({
          id: "st-bg",
          title: "audit",
          model: "Fast Model",
          status: "interrupted",
          activationCount: 1,
          usage: {
            totalTokens: 100,
            inputTokens: 40,
            cachedInputTokens: 50,
            outputTokens: 10,
            toolUses: 2,
            durationMs: 5_000,
          },
        });
        expect(tasks.find((event) => event.type === "task.started")?.createdAt).toBe(
          "2026-09-21T14:13:20.000Z",
        );
      }),
    ));

  it("maps a workflow tool result when extension events are unavailable", () =>
    run(
      Effect.gen(function* () {
        const adapter = yield* fixture([
          open,
          {
            expect: { type: "prompt" },
            events: [
              { type: "agent_start" },
              {
                type: "tool_execution_end",
                toolName: "eval",
                toolCallId: "workflow-cell",
                result: {
                  details: {
                    kind: "waited",
                    run_id: "run-tool",
                    result: {
                      snapshot: {
                        runId: "run-tool",
                        runKey: "probe",
                        name: "Tool workflow",
                        status: "completed",
                        createdAt: "2026-09-28T10:00:00.000Z",
                        completedAt: "2026-09-28T10:01:00.000Z",
                        waves: [{ index: 0, nodeIds: ["one"] }],
                        nodes: [
                          {
                            id: "one",
                            prompt: "do one",
                            state: "completed",
                            taskId: "st-tool-one",
                            attempt: 1,
                            startedAt: "2026-09-28T10:00:10.000Z",
                            completedAt: "2026-09-28T10:00:50.000Z",
                            runStats: { total_tokens: 300, output_tokens: 20 },
                          },
                        ],
                      },
                    },
                  },
                },
              },
              ...completed,
            ],
          },
        ]);
        yield* adapter.startSession(start);
        const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
        yield* adapter.sendTurn({ threadId, input: "run workflow" });
        const received = yield* Fiber.join(events);
        const activities = received
          .filter((event) => event.type.startsWith("task."))
          .flatMap((event) => runtimeEventToActivities(event));
        const agents = foldSubagentActivities(activities);
        expect(agents.find((agent) => agent.id === "run-tool")).toMatchObject({
          kind: "workflow",
          status: "completed",
          phases: [{ index: 0, title: "Phase 1" }],
        });
        expect(agents.find((agent) => agent.id === "st-tool-one")).toMatchObject({
          kind: "workflow_agent",
          status: "completed",
          phaseIndex: 0,
          usage: { totalTokens: 300, outputTokens: 20 },
        });
      }),
    ));

  it("maps DAG snapshots and activity into workflow phases and terminal members", () =>
    run(
      Effect.gen(function* () {
        const running = {
          run_id: "run-1",
          run_key: "ship",
          name: "Ship feature",
          status: "running",
          created_at: "2026-09-28T10:00:00.000Z",
          updated_at: "2026-09-28T10:01:00.000Z",
          waves: [
            { index: 0, node_ids: ["research"] },
            { index: 1, node_ids: ["verify"] },
          ],
          nodes: [
            {
              id: "research",
              label: "Research",
              prompt: "inspect",
              state: "completed",
              task_id: "st-research",
              attempt: 1,
              started_at: "2026-09-28T10:00:10.000Z",
              completed_at: "2026-09-28T10:00:50.000Z",
            },
            {
              id: "verify",
              label: "Verify",
              prompt: "test",
              state: "running",
              task_id: "st-verify",
              attempt: 2,
              started_at: "2026-09-28T10:00:55.000Z",
            },
          ],
        };
        const adapter = yield* fixture([
          open,
          {
            expect: { type: "prompt" },
            events: [
              { type: "agent_start" },
              { type: "extension_event", name: "omo.dag.updated", data: { runs: [running] } },
              {
                type: "extension_event",
                name: "omo.dag.activity",
                data: {
                  runId: "run-1",
                  nodeId: "verify",
                  taskId: "st-verify",
                  at: "2026-09-28T10:01:30.000Z",
                  activity: "tool",
                  currentTool: "bash",
                  lastAssistantLine: "Running tests",
                },
              },
              {
                type: "extension_event",
                name: "omo.dag.updated",
                data: {
                  runs: [
                    {
                      ...running,
                      status: "completed",
                      updated_at: "2026-09-28T10:02:00.000Z",
                      nodes: running.nodes.map((node) => ({
                        ...node,
                        state: "completed",
                        completed_at: "2026-09-28T10:02:00.000Z",
                      })),
                    },
                  ],
                },
              },
              ...completed,
            ],
          },
        ]);
        yield* adapter.startSession(start);
        const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
        yield* adapter.sendTurn({ threadId, input: "run workflow" });
        const received = yield* Fiber.join(events);
        const activities = received
          .filter((event) => event.type.startsWith("task."))
          .flatMap((event) => runtimeEventToActivities(event));
        const agents = foldSubagentActivities(activities);
        const workflow = agents.find((agent) => agent.id === "run-1");
        const verify = agents.find((agent) => agent.id === "st-verify");
        expect(workflow).toMatchObject({
          kind: "workflow",
          title: "Ship feature",
          status: "completed",
          workflowName: "Ship feature",
          phases: [
            { index: 0, title: "Phase 1" },
            { index: 1, title: "Phase 2" },
          ],
          runHandles: { runId: "run-1" },
        });
        expect(verify).toMatchObject({
          kind: "workflow_agent",
          status: "completed",
          parentAgentId: "run-1",
          phaseIndex: 1,
          phaseTitle: "Phase 2",
          attempt: 2,
          lastToolName: "bash",
          progress: "Running tests",
        });
      }),
    ));

  it.each(["steer", "queue"] as const)("sends %s delivery to a running turn", (delivery) =>
    run(
      Effect.gen(function* () {
        // Given
        const adapter = yield* fixture([
          open,
          { expect: { type: "prompt" }, events: [{ type: "agent_start" }] },
          {
            expect: {
              type: delivery === "queue" ? "follow_up" : "steer",
              sessionId: "rpc-1",
              message: "next",
            },
            events: completed,
          },
        ]);
        yield* adapter.startSession(start);
        const first = yield* adapter.sendTurn({ threadId, input: "start" });
        const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
        // When
        const second = yield* adapter.sendTurn({
          threadId,
          input: "next",
          followUpBehavior: delivery,
        });
        const received = yield* Fiber.join(events);
        // Then
        expect(second.turnId).toBe(first.turnId);
        expect(received.at(-1)?.type).toBe("turn.completed");
      }),
    ),
  );

  it("aborts the active turn and reports interruption", () =>
    run(
      Effect.gen(function* () {
        // Given
        const adapter = yield* fixture([
          open,
          { expect: { type: "prompt" }, events: [{ type: "agent_start" }] },
          { expect: { type: "clear_queue", sessionId: "rpc-1" } },
          { expect: { type: "abort", sessionId: "rpc-1" }, events: [{ type: "agent_settled" }] },
        ]);
        yield* adapter.startSession(start);
        yield* adapter.sendTurn({ threadId, input: "start" });
        const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
        // When
        yield* adapter.interruptTurn(threadId);
        const received = yield* Fiber.join(events);
        // Then
        expect(received.find((event) => event.type === "turn.completed")?.payload.state).toBe(
          "interrupted",
        );
      }),
    ));

  it("reports provider failure instead of successful completion", () =>
    run(
      Effect.gen(function* () {
        // Given
        const adapter = yield* fixture([
          open,
          {
            expect: { type: "prompt" },
            events: [
              {
                type: "turn_end",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: "fixture-failure",
                },
              },
              { type: "agent_settled" },
            ],
          },
        ]);
        yield* adapter.startSession(start);
        const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
        // When
        yield* adapter.sendTurn({ threadId, input: "fail" });
        const received = yield* Fiber.join(events);
        // Then
        expect(received.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
          state: "failed",
          errorMessage: "fixture-failure",
        });
      }),
    ));
});
