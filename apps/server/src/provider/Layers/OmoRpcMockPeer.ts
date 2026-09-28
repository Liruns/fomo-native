// Scripted subprocess peer: exercise the real stdin/stdout transport, not a mock adapter.
// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { partialDeepStrictEqual } from "node:assert/strict";
import * as Schema from "effect/Schema";

const Record = Schema.Record(Schema.String, Schema.Unknown);
const Script = Schema.Array(
  Schema.Struct({
    expect: Record,
    data: Schema.optional(Schema.Unknown),
    events: Schema.optional(Schema.Array(Record)),
    success: Schema.optional(Schema.Boolean),
    error: Schema.optional(Schema.String),
  }),
);
const scriptPath = process.env.OMO_RPC_SCRIPT;
if (!scriptPath) throw new TypeError("OMO_RPC_SCRIPT is required");
const steps = [
  ...Schema.decodeSync(Schema.fromJsonString(Script))(readFileSync(scriptPath, "utf8")),
];
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Record));
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = decode(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const step = steps.shift();
    if (!step && request.type === "close_session") {
      write({ type: "response", id: request.id, command: request.type, success: true });
      continue;
    }
    try {
      partialDeepStrictEqual(request, step?.expect);
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      write({
        type: "response",
        id: request.id,
        command: request.type,
        success: false,
        error: cause.message,
      });
      process.exitCode = 1;
      continue;
    }
    if (request.type !== "extension_ui_response")
      write({
        type: "response",
        id: request.id,
        sessionId: request.sessionId,
        command: request.type,
        success: step?.success ?? true,
        data: step?.data,
        error: step?.error,
      });
    for (const frame of step?.events ?? []) write({ sessionId: request.sessionId, ...frame });
  }
});
process.stdin.on("end", () => {
  if (steps.length) process.exitCode = 1;
});
