import { RuntimeRequestId, type ProviderUserInputAnswers } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OmoRpcDialog, omoRpcError, type OmoRpcFrame } from "./OmoRpcProtocol.ts";
import type { OmoRpcEmit } from "./OmoRpcTools.ts";
import type { OmoRpcTransport } from "./OmoRpcTransport.ts";

const Answers = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String), Schema.Boolean]),
);

export class OmoRpcRequests {
  private readonly pending = new Map<string, OmoRpcDialog>();
  private readonly emit: OmoRpcEmit;
  constructor(emit: OmoRpcEmit) {
    this.emit = emit;
  }

  open(dialog: OmoRpcDialog): void {
    switch (dialog.method) {
      case "question":
      case "select":
      case "confirm":
      case "input":
      case "editor":
        break;
      default:
        return; // Fire-and-forget widgets do not block the turn.
    }
    if (this.pending.has(dialog.id)) return;
    this.pending.set(dialog.id, dialog);
    const requestId = RuntimeRequestId.make(dialog.id);
    const questions =
      dialog.method === "question"
        ? (dialog.questions ?? []).map((question) => ({
            ...question,
            header: question.header || "Question",
            multiSelect: question.multiSelect ?? false,
            options: (question.options ?? []).map((option) => ({
              ...option,
              description: option.description ?? "",
            })),
            allowCustomAnswer: true,
          }))
        : [
            {
              id: dialog.id,
              header: dialog.title || "Question",
              question: dialog.message || dialog.title || "Enter a response",
              options: (dialog.method === "confirm" ? ["Yes", "No"] : (dialog.options ?? [])).map(
                (label) => ({ label, description: "" }),
              ),
              multiSelect: false,
              allowCustomAnswer: dialog.method === "input" || dialog.method === "editor",
            },
          ];
    this.emit({
      type: "request.opened",
      requestId,
      payload: { requestType: "tool_user_input", args: dialog },
    });
    this.emit({ type: "user-input.requested", requestId, payload: { questions } });
    this.emit({ type: "session.state.changed", payload: { state: "waiting" } });
  }

  handle(frame: OmoRpcFrame): void {
    switch (frame.type) {
      case "extension_ui_request": {
        const dialog = Schema.decodeUnknownSync(OmoRpcDialog)(frame);
        this.open(dialog);
        return;
      }
      case "question_resolved":
        if (frame.id) this.resolve(frame.id, {});
        return;
      default:
        return;
    }
  }

  private resolve(id: string, answers: ProviderUserInputAnswers): void {
    if (!this.pending.delete(id)) return;
    const requestId = RuntimeRequestId.make(id);
    this.emit({
      type: "request.resolved",
      requestId,
      payload: { requestType: "tool_user_input", resolution: answers },
    });
    this.emit({ type: "user-input.resolved", requestId, payload: { answers } });
    if (this.pending.size === 0)
      this.emit({ type: "session.state.changed", payload: { state: "running" } });
  }

  readonly respond = Effect.fn("OmoRpcRequests.respond")(function* (
    this: OmoRpcRequests,
    transport: OmoRpcTransport,
    sessionId: string,
    input: { readonly requestId: string; readonly answers: ProviderUserInputAnswers },
  ) {
    const dialog = this.pending.get(input.requestId);
    if (!dialog) return yield* omoRpcError("extension_ui_response", "Unknown or resolved dialog");
    const answers = yield* Schema.decodeUnknownEffect(Answers)(input.answers).pipe(
      Effect.mapError((cause) => omoRpcError("extension_ui_response", cause)),
    );
    const value = Object.values(answers)[0];
    let response: Readonly<Record<string, unknown>>;
    if (Object.keys(answers).length === 0) response = { cancelled: true };
    else
      switch (dialog.method) {
        case "question":
          response = {
            answers: Object.fromEntries(
              Object.entries(answers).map(([id, answer]) => {
                const values =
                  typeof answer === "boolean"
                    ? [String(answer)]
                    : typeof answer === "string"
                      ? [answer]
                      : answer;
                const options =
                  dialog.questions?.find((question) => question.id === id)?.options ?? [];
                const selected = values.filter((entry) =>
                  options.some((option) => (option.value ?? option.label) === entry),
                );
                const text = values.filter((entry) => !selected.includes(entry)).join("\n");
                return [id, { selected, ...(text ? { text } : {}) }];
              }),
            ),
          };
          break;
        case "confirm":
          response = { confirmed: value === true || value === "Yes" || value === "true" };
          break;
        default:
          response = { value: Array.isArray(value) ? value.join("\n") : String(value ?? "") };
      }
    yield* transport.notify({
      type: "extension_ui_response",
      sessionId,
      id: dialog.id,
      ...response,
    });
    this.resolve(dialog.id, answers);
  });
}
