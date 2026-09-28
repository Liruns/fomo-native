// @effect-diagnostics nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { type ProviderInstanceId, type ProviderSendTurnInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { OmoRpcDisposition, omoRpcError } from "./OmoRpcProtocol.ts";
import type { OmoRpcSession } from "./OmoRpcSession.ts";
import type { OmoRpcTransport } from "./OmoRpcTransport.ts";

// Queue is client-owned in the current app, not an interactionMode (default/plan).
// Native embedders can explicitly choose RPC follow_up with this delivery hint.
export type OmoRpcSendTurnInput = ProviderSendTurnInput & {
  readonly followUpBehavior?: "steer" | "queue";
};
export type OmoRpcModelSelection = {
  readonly instanceId: ProviderInstanceId;
  readonly resolveModel: (slug: string) => Effect.Effect<string | undefined>;
  readonly attachmentsDir?: string;
};

/** Serializes model configuration and input delivery for each session. */
export class OmoRpcTurns {
  private readonly transport: OmoRpcTransport;
  private readonly options: OmoRpcModelSelection;
  constructor(transport: OmoRpcTransport, options: OmoRpcModelSelection) {
    this.transport = transport;
    this.options = options;
  }

  readonly configure = Effect.fn("OmoRpc.configure")(function* (
    this: OmoRpcTurns,
    session: OmoRpcSession,
    selection: ProviderSendTurnInput["modelSelection"],
  ) {
    if (!selection || selection.instanceId !== this.options.instanceId) return;
    const model = yield* this.options.resolveModel(selection.model);
    if (model && model !== session.resolvedModel) {
      const separator = model.indexOf("/");
      if (separator < 1) return yield* omoRpcError("set_model", `Invalid model id: ${model}`);
      yield* this.transport.request({
        type: "set_model",
        sessionId: session.route,
        provider: model.slice(0, separator),
        modelId: model.slice(separator + 1),
      });
      session.resolvedModel = model;
      session.session = { ...session.session, model: selection.model };
    }
    const effort = getModelSelectionStringOptionValue(selection, "reasoningEffort");
    const level = effort === "none" ? "off" : effort;
    if (level && level !== session.thinkingLevel) {
      yield* this.transport.request({
        type: "set_thinking_level",
        sessionId: session.route,
        level,
      });
      session.thinkingLevel = level;
    }
  });

  readonly send = Effect.fn("OmoRpc.sendTurn")(function* (
    this: OmoRpcTurns,
    session: OmoRpcSession,
    input: OmoRpcSendTurnInput,
  ) {
    yield* this.configure(session, input.modelSelection);
    const attachmentsDir = this.options.attachmentsDir;
    const images = yield* Effect.forEach(
      (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
      (attachment) =>
        Effect.gen(function* () {
          const path = attachmentsDir
            ? resolveAttachmentPath({ attachmentsDir, attachment })
            : null;
          if (!path) return yield* omoRpcError("prompt", `Cannot resolve image ${attachment.id}`);
          const data = yield* Effect.tryPromise({
            try: () => readFile(path),
            catch: (cause) => omoRpcError("attachment", cause),
          });
          return { type: "image", data: data.toString("base64"), mimeType: attachment.mimeType };
        }),
    );
    const running = session.session.activeTurnId !== undefined;
    const type =
      running && !input.input?.startsWith("/")
        ? input.followUpBehavior === "queue"
          ? "follow_up"
          : "steer"
        : "prompt";
    const turnId = session.begin();
    const response = yield* this.transport
      .request({
        type,
        sessionId: session.route,
        message: input.input ?? "",
        ...(images.length ? { images } : {}),
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            if (!running) session.reject(cause.message);
          }),
        ),
      );
    // Local slash commands can finish without starting an agent at all.
    if (type === "prompt" && response !== undefined) {
      const disposition = yield* Schema.decodeUnknownEffect(OmoRpcDisposition)(response).pipe(
        Effect.mapError((cause) => omoRpcError("prompt", cause)),
      );
      if (!running && disposition.disposition === "handled") session.complete();
    }
    return { threadId: input.threadId, turnId, resumeCursor: session.session.resumeCursor };
  });
}
