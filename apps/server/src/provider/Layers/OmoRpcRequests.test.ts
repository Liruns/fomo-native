import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  collectTurn,
  completed,
  fixture,
  instanceId,
  open,
  run,
  start,
  threadId,
} from "./OmoRpcTestFixture.ts";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
describe("OmoRpcAdapter session configuration and dialogs", () => {
  it("routes concurrent sessions over the same RPC process", () =>
    run(
      Effect.gen(function* () {
        // Given: a second handshake would fail this peer's command script.
        const otherId = ThreadId.make("other-thread");
        const adapter = yield* fixture([
          open,
          {
            expect: { type: "open_session" },
            data: { sessionId: "rpc-2", state: { sessionFile: "C:/other.jsonl" } },
          },
          { expect: { type: "prompt", sessionId: "rpc-2" }, events: completed },
        ]);
        yield* adapter.startSession(start);
        yield* adapter.startSession({ ...start, threadId: otherId });
        const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
        // When
        yield* adapter.sendTurn({ threadId: otherId, input: "hello" });
        const received = yield* Fiber.join(events);
        // Then
        expect(
          received
            .filter((event) => event.type === "turn.completed")
            .map((event) => event.threadId),
        ).toEqual([otherId]);
      }),
    ));

  it("settles a handled slash command without waiting for agent events", () =>
    run(
      Effect.gen(function* () {
        // Given
        const adapter = yield* fixture([
          open,
          { expect: { type: "prompt", message: "/tasks" }, data: { disposition: "handled" } },
        ]);
        yield* adapter.startSession(start);
        const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
        // When
        yield* adapter.sendTurn({ threadId, input: "/tasks" });
        const received = yield* Fiber.join(events);
        // Then
        expect(received.find((event) => event.type === "turn.completed")?.payload.state).toBe(
          "completed",
        );
      }),
    ));

  it("applies a resolved profile and effort before prompting", () =>
    run(
      Effect.gen(function* () {
        // Given
        const adapter = yield* fixture([
          open,
          { expect: { type: "set_model", provider: "test-provider", modelId: "model/large" } },
          { expect: { type: "set_thinking_level", level: "high" } },
          { expect: { type: "prompt" }, events: completed },
        ]);
        yield* adapter.startSession(start);
        const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
        // When
        yield* adapter.sendTurn({
          threadId,
          input: "start",
          modelSelection: {
            instanceId,
            model: "profile:heavy",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        });
        yield* Fiber.join(events);
        // Then
        expect((yield* adapter.listSessions())[0]?.model).toBe("profile:heavy");
      }),
    ));

  it("reopens the durable path rather than the ephemeral routing id", () =>
    run(
      Effect.gen(function* () {
        // Given
        const adapter = yield* fixture([
          open,
          { expect: { type: "close_session", sessionId: "rpc-1" } },
          {
            expect: { type: "open_session", sessionPath: "C:/session.jsonl" },
            data: { sessionId: "rpc-2", state: { sessionFile: "C:/session.jsonl" } },
          },
        ]);
        const first = yield* adapter.startSession(start);
        yield* adapter.stopSession(threadId);
        // When
        const resumed = yield* adapter.startSession({ ...start, resumeCursor: first.resumeCursor });
        // Then
        expect(resumed.resumeCursor).toEqual({ sessionPath: "C:/session.jsonl" });
      }),
    ));

  it.each(["question", "select", "confirm", "input"])(
    "answers an extension %s without waiting for a nonexistent RPC acknowledgement",
    (method) =>
      run(
        Effect.gen(function* () {
          // Given
          const response =
            method === "question"
              ? { answers: { q1: { selected: ["Yes"] } } }
              : method === "confirm"
                ? { confirmed: true }
                : { value: "Yes" };
          const adapter = yield* fixture([
            open,
            {
              expect: { type: "prompt" },
              events: [
                {
                  type: "extension_ui_request",
                  id: "dialog-1",
                  method,
                  title: "Choose",
                  options: ["Yes", "No"],
                  questions: [
                    {
                      id: "q1",
                      header: "Choice",
                      question: "Choose",
                      options: [{ label: "Yes" }, { label: "No" }],
                    },
                  ],
                },
              ],
            },
            {
              expect: {
                type: "extension_ui_response",
                id: "dialog-1",
                sessionId: "rpc-1",
                ...response,
              },
              events: completed,
            },
          ]);
          yield* adapter.startSession(start);
          const opened = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "user-input.requested"),
            Stream.runCollect,
            Effect.timeout("10 seconds"),
            Effect.forkScoped,
          );
          yield* adapter.sendTurn({ threadId, input: "ask" });
          yield* Fiber.join(opened);
          const events = yield* collectTurn(adapter).pipe(Effect.forkScoped);
          // When
          yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("dialog-1"), {
            [method === "question" ? "q1" : "dialog-1"]: "Yes",
          });
          const received = yield* Fiber.join(events);
          // Then
          expect(received.some((event) => event.type === "request.resolved")).toBe(true);
        }),
      ),
  );
});
