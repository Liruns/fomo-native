import * as Schema from "effect/Schema";
import { ProviderAdapterRequestError } from "../Errors.ts";

const Text = Schema.String;
const MaybeText = Schema.optional(Text);
const Question = Schema.Struct({
  id: Text,
  header: MaybeText,
  question: Text,
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        label: Text,
        description: MaybeText,
        value: MaybeText,
      }),
    ),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
});
export const OmoRpcDialog = Schema.Struct({
  id: Text,
  method: Text,
  title: MaybeText,
  message: MaybeText,
  options: Schema.optional(Schema.Array(Text)),
  questions: Schema.optional(Schema.Array(Question)),
});
export type OmoRpcDialog = typeof OmoRpcDialog.Type;

const TaskDetails = Schema.StructWithRest(
  Schema.Struct({
    task_id: MaybeText,
    task_summary: MaybeText,
    name: MaybeText,
    status: MaybeText,
    model: MaybeText,
    resolved_model: Schema.optional(
      Schema.StructWithRest(Schema.Struct({ display: MaybeText }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    ),
    progress: Schema.optional(
      Schema.StructWithRest(
        Schema.Struct({ activity: MaybeText, startedAt: Schema.optional(Schema.Unknown) }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
    run_stats: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type OmoRpcTaskDetails = typeof TaskDetails.Type;
const ToolResult = Schema.Struct({
  content: Schema.optional(Schema.Array(Schema.Struct({ type: Text, text: MaybeText }))),
  details: Schema.optional(Schema.NullOr(TaskDetails)),
});
const Message = Schema.Struct({
  role: Text,
  stopReason: MaybeText,
  errorMessage: MaybeText,
  content: Schema.optional(
    Schema.Union([
      Text,
      Schema.Array(
        Schema.Struct({
          type: Text,
          text: MaybeText,
          thinking: MaybeText,
        }),
      ),
    ]),
  ),
});

// The wire vocabulary is additive. Unknown types are accepted and ignored;
// known fields are parsed here, never cast out of arbitrary JSON downstream.
export const OmoRpcFrame = Schema.Struct({
  type: Text,
  sessionId: MaybeText,
  id: MaybeText,
  command: MaybeText,
  success: Schema.optional(Schema.Boolean),
  error: MaybeText,
  data: Schema.optional(Schema.Unknown),
  assistantMessageEvent: Schema.optional(
    Schema.Struct({
      type: Text,
      delta: MaybeText,
      contentIndex: Schema.optional(Schema.Number),
    }),
  ),
  message: Schema.optional(Schema.Union([Text, Message])),
  toolCallId: MaybeText,
  toolName: MaybeText,
  args: Schema.optional(Schema.Unknown),
  partialResult: Schema.optional(ToolResult),
  result: Schema.optional(ToolResult),
  isError: Schema.optional(Schema.Boolean),
  method: MaybeText,
  name: MaybeText,
  title: MaybeText,
  options: Schema.optional(Schema.Array(Text)),
  questions: Schema.optional(Schema.Array(Question)),
  outcome: MaybeText,
  reason: MaybeText,
  sessionFile: MaybeText,
  durableSessionId: MaybeText,
});
export type OmoRpcFrame = typeof OmoRpcFrame.Type;
export const decodeOmoRpcFrame = Schema.decodeUnknownSync(Schema.fromJsonString(OmoRpcFrame));
export const OmoRpcOpen = Schema.Struct({
  sessionId: Text,
  state: Schema.Struct({
    sessionId: MaybeText,
    sessionFile: MaybeText,
    sessionPath: MaybeText,
    pendingQuestions: Schema.optional(Schema.Array(OmoRpcDialog)),
  }),
});
export const OmoRpcResume = Schema.Struct({ sessionPath: Text });
export const OmoRpcDisposition = Schema.Struct({ disposition: MaybeText });
export const OmoRpcMessages = Schema.Struct({ messages: Schema.Array(Schema.Unknown) });
export const omoRpcError = (method: string, cause: unknown) =>
  new ProviderAdapterRequestError({
    provider: "omo",
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export type OmoRpcCommand = Readonly<Record<string, unknown>> & { readonly type: string };
