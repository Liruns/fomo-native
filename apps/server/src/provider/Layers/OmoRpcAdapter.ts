// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  ProviderDriverKind,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ProviderAdapterSessionNotFoundError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { OmoRpcMessages, OmoRpcOpen, OmoRpcResume, omoRpcError } from "./OmoRpcProtocol.ts";
import { OmoRpcSession } from "./OmoRpcSession.ts";
import { OmoRpcTransport } from "./OmoRpcTransport.ts";
import { OmoRpcTurns, type OmoRpcSendTurnInput } from "./OmoRpcTurns.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";

const MCP_BRIDGE_ENV = "OMO_T3_MCP_BRIDGE_URL";
const MCP_BRIDGE_CONTEXT_KEY = "t3_mcp_key";
const MCP_BRIDGE_EXTENSION = `
export default async function (pi) {
  const root = process.env.${MCP_BRIDGE_ENV};
  const key = pi.sessionContext?.${MCP_BRIDGE_CONTEXT_KEY};
  if (!root || !key || !/^[0-9a-f-]{36}$/.test(key)) return;
  const response = await fetch(root + "/" + key);
  if (!response.ok) throw new Error("t3-code MCP session credential unavailable");
  const config = await response.json();
  pi.registerMcpServer("t3-code", {
    type: "http",
    url: config.endpoint,
    headers: { Authorization: config.authorizationHeader },
    lifecycle: "eager",
    exposure: "direct",
  });
}
`;

const makeMcpBridge = (makeKey: () => string = randomUUID) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          readonly url: string;
          readonly extensionPath: string;
          readonly prepare: (
            threadId: ThreadId,
            config: McpProviderSession.McpProviderSessionConfig,
          ) => string;
          readonly remove: (threadId: ThreadId) => void;
          readonly close: () => Promise<void>;
        }>((resolve, reject) => {
          const directory = mkdtempSync(join(tmpdir(), "t3-omo-mcp-"));
          const extensionPath = join(directory, "bridge.mjs");
          writeFileSync(extensionPath, MCP_BRIDGE_EXTENSION, { encoding: "utf8", mode: 0o600 });
          const credentials = new Map<
            string,
            { readonly endpoint: string; readonly authorizationHeader: string }
          >();
          const keys = new Map<ThreadId, string>();
          const server = createServer((request, response) => {
            const key = request.url?.slice(1);
            const credential = key ? credentials.get(key) : undefined;
            if (request.method !== "GET" || !key || !credential) {
              response.writeHead(404).end();
              return;
            }
            credentials.delete(key);
            response.writeHead(200, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            });
            response.end(JSON.stringify(credential));
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
              server.close();
              reject(new Error("OmO MCP credential bridge did not bind a TCP port"));
              return;
            }
            resolve({
              url: `http://127.0.0.1:${address.port}`,
              extensionPath,
              prepare(threadId, config) {
                const previous = keys.get(threadId);
                if (previous) credentials.delete(previous);
                const key = makeKey();
                credentials.set(key, {
                  endpoint: config.endpoint,
                  authorizationHeader: config.authorizationHeader,
                });
                keys.set(threadId, key);
                return key;
              },
              remove(threadId) {
                const key = keys.get(threadId);
                if (!key) return;
                keys.delete(threadId);
                credentials.delete(key);
              },
              close: () =>
                new Promise<void>((closed) => {
                  server.close(() => {
                    rmSync(directory, { recursive: true, force: true });
                    closed();
                  });
                }),
            });
          });
        }),
    ),
    (bridge) => Effect.promise(bridge.close),
  );

export type OmoRpcAdapterOptions = {
  readonly binaryPath: string;
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly resolveModel: (slug: string) => Effect.Effect<string | undefined>;
  readonly attachmentsDir?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Executable prefix for embedders and scripted JSONL peers. */
  readonly binaryArgs?: ReadonlyArray<string>;
  /** Stable only in transport tests; production credentials always use random UUID keys. */
  readonly makeMcpBridgeKey?: () => string;
};
export type OmoRpcAdapter = Omit<ProviderAdapterShape<ProviderAdapterError>, "sendTurn"> & {
  readonly sendTurn: (
    input: OmoRpcSendTurnInput,
  ) => ReturnType<ProviderAdapterShape<ProviderAdapterError>["sendTurn"]>;
};

export const makeOmoRpcAdapter = Effect.fn("makeOmoRpcAdapter")(function* (
  options: OmoRpcAdapterOptions,
) {
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, OmoRpcSession>();
  const routes = new Map<string, OmoRpcSession>();
  const lifecycle = yield* Semaphore.make(1);
  const mcpBridge = yield* makeMcpBridge(options.makeMcpBridgeKey);
  // The stdio RPC host binds extension events before it reads set_client_info.
  const environment = {
    ...options.environment,
    OMO_RPC_CLIENT_CAPABILITIES: "extension_events",
    [MCP_BRIDGE_ENV]: mcpBridge.url,
  };
  const command = yield* resolveSpawnCommand(
    options.binaryPath,
    [
      ...(options.binaryArgs ?? []),
      "--mode",
      "rpc",
      "--multi-session",
      "--extension",
      mcpBridge.extensionPath,
    ],
    { env: environment },
  );
  let initialized = false;
  const nativeEvents = yield* Queue.unbounded<{
    readonly frame: unknown;
    readonly threadId: ThreadId | null;
  }>();
  if (options.nativeEventLogger) {
    const logger = options.nativeEventLogger;
    yield* Stream.runForEach(Stream.fromQueue(nativeEvents), ({ frame, threadId }) =>
      logger.write(frame, threadId),
    ).pipe(Effect.forkScoped);
  }
  const transport = new OmoRpcTransport({
    command,
    environment,
    onFrame: (frame) => {
      const session = frame.sessionId ? routes.get(frame.sessionId) : undefined;
      if (options.nativeEventLogger)
        Queue.offerUnsafe(nativeEvents, { frame, threadId: session?.session.threadId ?? null });
      session?.handle(frame);
    },
    onFailure: (error) => {
      initialized = false;
      for (const session of sessions.values()) session.fail(error.message);
    },
  });
  const requireSession = Effect.fn("OmoRpc.requireSession")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!session || session.session.status === "closed" || session.session.status === "error") {
      return yield* new ProviderAdapterSessionNotFoundError({ provider: "omo", threadId });
    }
    return session;
  });
  const turns = new OmoRpcTurns(transport, options);
  const stopSession: OmoRpcAdapter["stopSession"] = Effect.fn("OmoRpc.stopSession")(
    function* (threadId) {
      const session = sessions.get(threadId);
      if (!session) return;
      if (session.session.status !== "closed" && session.session.status !== "error") {
        yield* transport.request({ type: "close_session", sessionId: session.route });
        session.stop();
      }
      routes.delete(session.route);
      sessions.delete(threadId);
      mcpBridge.remove(threadId);
    },
  );
  const stopAll = Effect.suspend(() =>
    Effect.forEach([...sessions.keys()], stopSession, { concurrency: 4, discard: true }),
  ).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        yield* transport.stop;
        sessions.clear();
        routes.clear();
        initialized = false;
      }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    stopAll.pipe(Effect.catch((error) => Effect.logWarning("OmO RPC shutdown failed", { error }))),
  );

  const startSession: OmoRpcAdapter["startSession"] = (input) =>
    lifecycle.withPermit(
      Effect.gen(function* () {
        yield* stopSession(input.threadId);
        if (!initialized) {
          yield* transport.request({
            type: "set_client_info",
            width: 120,
            capabilities: ["question", "extension_events"],
          });
          initialized = true;
        }
        const resume =
          input.resumeCursor === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(OmoRpcResume)(input.resumeCursor).pipe(
                Effect.mapError((cause) => omoRpcError("resume", cause)),
              );
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const mcpKey = mcpSession ? mcpBridge.prepare(input.threadId, mcpSession) : undefined;
        const opened = yield* transport
          .request({
            type: "open_session",
            cwd: input.cwd ?? process.cwd(),
            ...(resume ? { sessionPath: resume.sessionPath } : {}),
            ...(mcpKey ? { context: { [MCP_BRIDGE_CONTEXT_KEY]: mcpKey } } : {}),
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(OmoRpcOpen)),
            Effect.mapError((cause) => omoRpcError("open_session", cause)),
            Effect.onError(() => Effect.sync(() => mcpBridge.remove(input.threadId))),
          );
        const sessionPath = opened.state.sessionFile ?? opened.state.sessionPath;
        const now = DateTime.formatIso(yield* DateTime.now);
        const session = new OmoRpcSession(
          opened.sessionId,
          {
            provider: ProviderDriverKind.make("omo"),
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
            ...(sessionPath ? { resumeCursor: { sessionPath } } : {}),
          },
          (event) => {
            Queue.offerUnsafe(events, event);
          },
        );
        sessions.set(input.threadId, session);
        routes.set(opened.sessionId, session);
        yield* turns
          .configure(session, input.modelSelection)
          .pipe(
            Effect.onError(() =>
              stopSession(input.threadId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("OmO RPC session cleanup failed", { error }),
                ),
              ),
            ),
          );
        session.emit({
          type: "session.started",
          payload: { resume: session.session.resumeCursor },
        });
        session.emit({ type: "session.state.changed", payload: { state: "ready" } });
        for (const dialog of opened.state.pendingQuestions ?? []) session.requests.open(dialog);
        return session.session;
      }),
    );
  const sendTurn: OmoRpcAdapter["sendTurn"] = Effect.fn("OmoRpc.sendTurn")(function* (input) {
    const session = yield* requireSession(input.threadId);
    return yield* session.sendLock.withPermit(turns.send(session, input));
  });
  return {
    provider: ProviderDriverKind.make("omo"),
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    stopSession,
    stopAll: () => stopAll,
    interruptTurn: (threadId) =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        session.interrupt();
        yield* transport.request({ type: "clear_queue", sessionId: session.route });
        yield* transport.request({ type: "abort", sessionId: session.route });
        session.complete();
      }),
    respondToUserInput: (threadId, requestId, answers) =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        yield* session.requests.respond(transport, session.route, { requestId, answers });
      }),
    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        yield* session.requests.respond(transport, session.route, {
          requestId,
          answers: decision === "cancel" ? {} : { [requestId]: decision.startsWith("accept") },
        });
      }),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((session) => session.session)),
    hasSession: (threadId) =>
      Effect.sync(() => {
        const status = sessions.get(threadId)?.session.status;
        return status !== undefined && status !== "closed" && status !== "error";
      }),
    readThread: (threadId) =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        const history = yield* transport
          .request({ type: "get_messages", sessionId: session.route })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(OmoRpcMessages)),
            Effect.mapError((cause) => omoRpcError("get_messages", cause)),
          );
        return {
          threadId,
          turns: history.messages.map((message, index) => ({
            id: TurnId.make(`${threadId}-history-${index}`),
            items: [message],
          })),
        };
      }),
    rollbackThread: () =>
      Effect.fail(omoRpcError("rollback", "OmO RPC does not support conversation rollback")),
    compaction: {
      type: "native",
      start: (threadId) =>
        Effect.gen(function* () {
          const session = yield* requireSession(threadId);
          yield* transport.request({ type: "compact", sessionId: session.route });
        }),
    },
    streamEvents: Stream.fromQueue(events),
  } satisfies OmoRpcAdapter;
});
