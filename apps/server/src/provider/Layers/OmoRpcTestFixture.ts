// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderInstanceId, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeOmoRpcAdapter } from "./OmoRpcAdapter.ts";

export const threadId = ThreadId.make("rpc-test");
export const instanceId = ProviderInstanceId.make("omo");
export const completed = [
  { type: "turn_end", message: { role: "assistant", stopReason: "stop" } },
  { type: "agent_end" },
  { type: "agent_settled" },
];
export const open = {
  expect: { type: "open_session" },
  data: { sessionId: "rpc-1", state: { sessionId: "durable-1", sessionFile: "C:/session.jsonl" } },
};
export const fixture = Effect.fn(function* (steps: readonly unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "omo-rpc-test-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  const script = join(dir, "script.json");
  const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))([
    { expect: { type: "set_client_info", capabilities: ["question", "extension_events"] } },
    ...steps,
  ]);
  writeFileSync(script, encoded);
  return yield* makeOmoRpcAdapter({
    binaryPath: process.execPath,
    binaryArgs: [fileURLToPath(new URL("./OmoRpcMockPeer.ts", import.meta.url))],
    environment: { ...process.env, OMO_RPC_SCRIPT: script },
    instanceId,
    makeMcpBridgeKey: () => "00000000-0000-4000-8000-000000000001",
    resolveModel: (slug) =>
      Effect.succeed(slug === "profile:heavy" ? "test-provider/model/large" : undefined),
  });
});
export const start = { threadId, runtimeMode: "full-access" as const };
export const collectTurn = (adapter: {
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}) =>
  adapter.streamEvents.pipe(
    Stream.takeUntil((event) => event.type === "turn.completed"),
    Stream.runCollect,
    Effect.timeout("10 seconds"),
  );
export const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));
