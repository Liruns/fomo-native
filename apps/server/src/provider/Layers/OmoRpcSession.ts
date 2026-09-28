// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Semaphore from "effect/Semaphore";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderRuntimeTurnStatus,
} from "@t3tools/contracts";
import type { OmoRpcFrame } from "./OmoRpcProtocol.ts";
import { OmoRpcTools, type OmoRpcEvent } from "./OmoRpcTools.ts";
import { OmoRpcRequests } from "./OmoRpcRequests.ts";

/** Mutable session projection; RPC routing ids never become durable resume ids. */
export class OmoRpcSession {
  readonly sendLock = Semaphore.makeUnsafe(1);
  readonly tools = new OmoRpcTools((event, createdAt) => this.emit(event, createdAt));
  readonly requests = new OmoRpcRequests((event) => this.emit(event));
  private outcome: ProviderRuntimeTurnStatus = "completed";
  private errorMessage: string | undefined;
  private messageNumber = 0;
  private text = "";
  private reasoning = "";
  private messageOpen = false;

  readonly route: string;
  session: ProviderSession;
  resolvedModel: string | undefined;
  thinkingLevel: string | undefined;
  private readonly publish: (event: ProviderRuntimeEvent) => void;

  constructor(
    route: string,
    session: ProviderSession,
    publish: (event: ProviderRuntimeEvent) => void,
  ) {
    this.route = route;
    this.session = session;
    this.publish = publish;
  }

  emit(event: OmoRpcEvent, createdAt?: string): void {
    this.publish({
      provider: ProviderDriverKind.make("omo"),
      providerInstanceId: this.session.providerInstanceId,
      threadId: this.session.threadId,
      createdAt: createdAt ?? DateTime.formatIso(DateTime.nowUnsafe()),
      ...(this.session.activeTurnId ? { turnId: this.session.activeTurnId } : {}),
      ...event,
      eventId: EventId.make(randomUUID()),
    });
  }

  begin(): TurnId {
    if (this.session.activeTurnId) return this.session.activeTurnId;
    const turnId = TurnId.make(randomUUID());
    this.outcome = "completed";
    this.errorMessage = undefined;
    this.session = {
      ...this.session,
      activeTurnId: turnId,
      status: "running",
      updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    };
    this.emit({ type: "session.state.changed", payload: { state: "running" } });
    this.emit({
      type: "turn.started",
      payload: { ...(this.session.model ? { model: this.session.model } : {}) },
    });
    return turnId;
  }

  interrupt(): void {
    this.outcome = "interrupted";
  }

  complete(): void {
    if (!this.session.activeTurnId) return;
    this.endMessage();
    this.emit({
      type: "turn.completed",
      payload: {
        state: this.outcome,
        ...(this.errorMessage ? { errorMessage: this.errorMessage } : {}),
      },
    });
    const { activeTurnId: _, ...rest } = this.session;
    this.session = {
      ...rest,
      status: "ready",
      updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    };
    this.emit({ type: "session.state.changed", payload: { state: "ready" } });
  }

  reject(message: string): void {
    this.outcome = "failed";
    this.errorMessage = message;
    this.complete();
  }

  fail(message: string): void {
    this.outcome = "failed";
    this.errorMessage = message;
    this.emit({ type: "runtime.error", payload: { message, class: "transport_error" } });
    this.complete();
    this.session = { ...this.session, status: "error", lastError: message };
    this.emit({ type: "session.state.changed", payload: { state: "error", reason: message } });
  }

  stop(): void {
    if (this.session.status === "closed") return;
    this.interrupt();
    this.complete();
    this.session = { ...this.session, status: "closed" };
    this.emit({ type: "session.state.changed", payload: { state: "stopped" } });
    this.emit({ type: "session.exited", payload: { exitKind: "graceful" } });
  }

  private itemId(kind: "text" | "reasoning") {
    return RuntimeItemId.make(`${this.session.activeTurnId}-${this.messageNumber}-${kind}`);
  }

  private beginMessage(): void {
    if (this.messageOpen) return;
    this.messageOpen = true;
    this.messageNumber++;
    this.text = "";
    this.reasoning = "";
  }

  private endMessage(): void {
    if (!this.messageOpen) return;
    for (const kind of ["text", "reasoning"] as const) {
      const content = kind === "text" ? this.text : this.reasoning;
      if (content)
        this.emit({
          type: "item.completed",
          itemId: this.itemId(kind),
          payload: {
            itemType: kind === "text" ? "assistant_message" : "reasoning",
            status: "completed",
            detail: content,
          },
        });
    }
    this.messageOpen = false;
  }

  handle(frame: OmoRpcFrame): void {
    switch (frame.type) {
      case "agent_start":
      case "turn_start":
        this.begin();
        return;
      // A senpi turn is one LLM/tool iteration. The app turn spans all retries,
      // tool iterations and queued continuations, until the agent is settled.
      case "agent_settled":
        this.complete();
        return;
      case "message_start":
        if (typeof frame.message === "object" && frame.message.role === "assistant")
          this.beginMessage();
        return;
      case "message_update": {
        const delta = frame.assistantMessageEvent;
        if (!delta?.delta) return;
        let kind: "text" | "reasoning";
        switch (delta.type) {
          case "text_delta":
            kind = "text";
            break;
          case "thinking_delta":
            kind = "reasoning";
            break;
          default:
            return;
        }
        this.beginMessage();
        if (!(kind === "text" ? this.text : this.reasoning))
          this.emit({
            type: "item.started",
            itemId: this.itemId(kind),
            payload: {
              itemType: kind === "text" ? "assistant_message" : "reasoning",
              status: "inProgress",
            },
          });
        if (kind === "text") this.text += delta.delta;
        else this.reasoning += delta.delta;
        this.emit({
          type: "content.delta",
          itemId: this.itemId(kind),
          payload: {
            streamKind: kind === "text" ? "assistant_text" : "reasoning_text",
            delta: delta.delta,
            ...(delta.contentIndex !== undefined ? { contentIndex: delta.contentIndex } : {}),
          },
        });
        return;
      }
      case "message_end":
      case "turn_end":
        if (typeof frame.message === "object" && frame.message.role === "assistant") {
          switch (frame.message.stopReason) {
            case "error":
              this.outcome = "failed";
              this.errorMessage = frame.message.errorMessage;
              break;
            case "aborted":
              this.outcome = "interrupted";
              break;
            default:
              if (this.outcome !== "interrupted") {
                this.outcome = "completed";
                this.errorMessage = undefined;
              }
          }
          this.endMessage();
        }
        return;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.tools.handle(frame);
        return;
      case "extension_event":
        this.tools.handleExtension(frame);
        return;
      case "extension_ui_request":
      case "question_resolved":
        this.requests.handle(frame);
        return;
      case "model_changed":
        this.resolvedModel = undefined;
        this.thinkingLevel = undefined;
        return;
      case "session_replaced":
        if (frame.sessionFile) {
          this.session = { ...this.session, resumeCursor: { sessionPath: frame.sessionFile } };
          this.emit({ type: "session.started", payload: { resume: this.session.resumeCursor } });
        }
        return;
      case "session_closed":
      case "session_parked":
        this.stop();
        return;
      case "compaction_end":
        this.emit({ type: "thread.state.changed", payload: { state: "compacted" } });
        return;
      case "response":
        if (frame.success === false)
          this.emit({
            type: "runtime.error",
            payload: { message: frame.error || "RPC request rejected" },
          });
        return;
      default:
        return;
    }
  }
}
