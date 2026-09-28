// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ResolvedSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  decodeOmoRpcFrame,
  omoRpcError,
  type OmoRpcCommand,
  type OmoRpcFrame,
} from "./OmoRpcProtocol.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ProviderAdapterRequestError) => void;
};
export type OmoRpcTransportOptions = {
  readonly command: ResolvedSpawnCommand;
  readonly environment: NodeJS.ProcessEnv;
  readonly onFrame: (frame: OmoRpcFrame) => void;
  readonly onFailure: (error: ProviderAdapterRequestError) => void;
};

/** Owns the one lazily spawned JSONL peer, including all outstanding requests. */
export class OmoRpcTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private buffer = "";
  private stderr = "";
  private closed: Promise<void> = Promise.resolve();

  private readonly options: OmoRpcTransportOptions;
  constructor(options: OmoRpcTransportOptions) {
    this.options = options;
  }

  private fail(error: ProviderAdapterRequestError): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.options.onFailure(error);
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const { command, environment } = this.options;
    const child = spawn(command.command, [...command.args], {
      env: environment,
      shell: command.shell,
      windowsHide: true,
      stdio: "pipe",
    });
    this.child = child;
    this.buffer = "";
    this.stderr = "";
    this.closed = new Promise((resolve) => child.once("close", () => resolve()));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
    });
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end).replace(/\r$/, "");
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        let frame: OmoRpcFrame;
        try {
          frame = decodeOmoRpcFrame(line);
        } catch (cause) {
          if (!(cause instanceof Error)) throw cause;
          this.fail(omoRpcError("decode", cause));
          child.kill();
          return;
        }
        const request =
          frame.type === "response" && frame.id ? this.pending.get(frame.id) : undefined;
        if (request && frame.id) {
          this.pending.delete(frame.id);
          if (frame.success) request.resolve(frame.data);
          else
            request.reject(
              omoRpcError(frame.command ?? "response", frame.error ?? "RPC command failed"),
            );
        } else {
          try {
            this.options.onFrame(frame);
          } catch (cause) {
            if (!(cause instanceof Error)) throw cause;
            this.fail(omoRpcError("event", cause));
            child.kill();
            return;
          }
        }
      }
      if (this.buffer.length > 16_777_216) {
        this.fail(omoRpcError("decode", "RPC record exceeded 16 MiB"));
        child.kill();
      }
    });
    child.stdin.on("error", (cause) => this.fail(omoRpcError("stdin", cause)));
    child.once("error", (cause) => this.fail(omoRpcError("spawn", cause)));
    child.once("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.fail(omoRpcError("process", `OmO exited (${signal ?? code}): ${this.stderr}`));
    });
    return child;
  }

  readonly request = (command: OmoRpcCommand) =>
    Effect.tryPromise({
      try: (signal) =>
        new Promise<unknown>((resolve, reject) => {
          const child = this.start();
          const id = `app-${++this.sequence}`;
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
          const aborted = () => {
            this.pending.delete(id);
            reject(omoRpcError(command.type, deadline.reason));
          };
          deadline.addEventListener("abort", aborted, { once: true });
          this.pending.set(id, {
            resolve: (value) => {
              deadline.removeEventListener("abort", aborted);
              resolve(value);
            },
            reject: (error) => {
              deadline.removeEventListener("abort", aborted);
              reject(error);
            },
          });
          child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
            if (!error) return;
            this.pending.get(id)?.reject(omoRpcError(command.type, error));
            this.pending.delete(id);
          });
        }),
      catch: (cause) =>
        Schema.is(ProviderAdapterRequestError)(cause) ? cause : omoRpcError(command.type, cause),
    });

  // UI responses are one-way: the native dialog id must not be replaced by a
  // transport correlation id, and the peer does not send a success response.
  readonly notify = (command: OmoRpcCommand) =>
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          this.start().stdin.write(`${JSON.stringify(command)}\n`, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
      catch: (cause) => omoRpcError(command.type, cause),
    });

  readonly stop = Effect.promise(async () => {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    for (const request of this.pending.values())
      request.reject(omoRpcError("stop", "RPC host stopped"));
    this.pending.clear();
    child.stdin.end();
    child.kill();
    await this.closed;
  });
}
