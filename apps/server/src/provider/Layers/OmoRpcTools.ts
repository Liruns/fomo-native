import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  RuntimeItemId,
  RuntimeTaskId,
  type CanonicalItemType,
  type ProviderRuntimeEvent,
  type RuntimeTaskStatus,
  type RuntimeTaskUsage,
  type TaskAgentLinkage,
} from "@t3tools/contracts";
import type { OmoRpcFrame, OmoRpcTaskDetails } from "./OmoRpcProtocol.ts";

export type OmoRpcEvent = ProviderRuntimeEvent extends infer E
  ? E extends ProviderRuntimeEvent
    ? Omit<E, "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt">
    : never
  : never;
export type OmoRpcEmit = (event: OmoRpcEvent, createdAt?: string) => void;

type TaskIdentity = TaskAgentLinkage & { readonly description: string };
type UnknownRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  return Option.match(DateTime.make(value), {
    onNone: () => undefined,
    onSome: DateTime.formatIso,
  });
}

function itemType(name: string): CanonicalItemType {
  switch (name.toLowerCase()) {
    case "bash":
    case "shell":
    case "terminal":
      return "command_execution";
    case "edit":
    case "write":
    case "apply_patch":
      return "file_change";
    case "task":
      return "collab_agent_tool_call";
    case "web_search":
    case "websearch":
      return "web_search";
    case "view_image":
      return "image_view";
    default:
      return name.startsWith("mcp") ? "mcp_tool_call" : "dynamic_tool_call";
  }
}

function runtimeStatus(value: string | undefined): RuntimeTaskStatus {
  switch (value) {
    case "pending":
    case "running":
    case "waiting":
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    case "paused":
      return "idle";
    case "error":
    case "lost":
      return "failed";
    default:
      return "running";
  }
}

function terminalStatus(value: string | undefined): "completed" | "failed" | "stopped" | undefined {
  switch (value) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
    case "lost":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    default:
      return undefined;
  }
}

function taskUsage(value: unknown): RuntimeTaskUsage | undefined {
  const stats = record(value);
  if (!stats) return undefined;
  const inputTokens = count(stats.input_tokens);
  const cachedInputTokens = count(stats.cache_read_tokens);
  const outputTokens = count(stats.output_tokens);
  const reportedTotal = count(stats.total_tokens);
  const totalTokens =
    reportedTotal ??
    (inputTokens !== undefined || cachedInputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  if (totalTokens === undefined) return undefined;
  const toolUses = count(stats.tool_calls);
  const durationMs = count(stats.runtime_ms);
  return {
    totalTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** Maps tool and OmO extension frames into canonical task lifecycles. */
export class OmoRpcTools {
  private readonly taskStatus = new Map<string, string>();
  private readonly taskIdentity = new Map<string, TaskIdentity>();
  private readonly taskIdByName = new Map<string, string>();
  private readonly workflowStatus = new Map<string, string>();
  private readonly emit: OmoRpcEmit;
  constructor(emit: OmoRpcEmit) {
    this.emit = emit;
  }

  private rememberTask(details: OmoRpcTaskDetails, toolUseId?: string): TaskIdentity | undefined {
    const taskId = text(details.task_id);
    if (!taskId) return undefined;
    const previous = this.taskIdentity.get(taskId);
    const description =
      text(details.task_summary) ?? previous?.description ?? text(details.name) ?? "Task";
    const name = text(details.name);
    const model =
      text(record(details.resolved_model)?.display) ?? text(details.model) ?? previous?.model;
    const identity: TaskIdentity = {
      taskType: "subagent",
      description,
      ...(name ? { title: name } : previous?.title ? { title: previous.title } : {}),
      ...(model ? { model } : {}),
      ...(toolUseId ? { toolUseId } : previous?.toolUseId ? { toolUseId: previous.toolUseId } : {}),
    };
    this.taskIdentity.set(taskId, identity);
    if (name) this.taskIdByName.set(name, taskId);
    return identity;
  }

  private emitTask(details: OmoRpcTaskDetails, toolUseId?: string, createdAt?: string): void {
    const rawTaskId = text(details.task_id);
    if (!rawTaskId) return;
    const taskId = RuntimeTaskId.make(rawTaskId);
    const identity = this.rememberTask(details, toolUseId);
    if (!identity) return;
    const { description, ...linkage } = identity;
    const status = text(details.status) ?? "running";
    const previousStatus = this.taskStatus.get(rawTaskId);
    const usage = taskUsage(details.run_stats);
    if (previousStatus === undefined) {
      this.emit({ type: "task.started", payload: { taskId, description, ...linkage } }, createdAt);
    }
    if (previousStatus === status && terminalStatus(status)) return;
    this.taskStatus.set(rawTaskId, status);
    const model = identity.model;
    const activity = text(record(details.progress)?.activity);
    const summary = [model, activity ?? description].filter(Boolean).join(" - ");
    const terminal = terminalStatus(status);
    if (terminal) {
      this.emit(
        {
          type: "task.completed",
          payload: {
            taskId,
            ...linkage,
            status: terminal,
            summary,
            ...(usage ? { typedUsage: usage } : {}),
          },
        },
        createdAt,
      );
      return;
    }
    this.emit(
      {
        type: "task.progress",
        payload: {
          taskId,
          ...linkage,
          description,
          summary,
          status: runtimeStatus(status),
          ...(usage ? { typedUsage: usage } : {}),
        },
      },
      createdAt,
    );
  }

  private handleTaskControl(frame: OmoRpcFrame, details: OmoRpcTaskDetails): void {
    if (frame.type !== "tool_execution_end") return;
    const args = record(frame.args);
    const resultTaskId = text(details.task_id);
    const target = resultTaskId ?? text(args?.task_id) ?? text(args?.to) ?? text(args?.name);
    const taskId = target
      ? this.taskIdentity.has(target)
        ? target
        : this.taskIdByName.get(target)
      : undefined;
    if (!taskId) return;
    const identity = this.taskIdentity.get(taskId);
    if (!identity) return;
    const status =
      frame.toolName === "task_cancel"
        ? (text(details.status) ??
          (record(details)?.kind === "cancelled" ? "cancelled" : undefined))
        : (text(details.status) ?? "running");
    this.emitTask(
      {
        ...details,
        task_id: taskId,
        task_summary: text(details.task_summary) ?? identity.description,
        status,
      },
      identity.toolUseId,
    );
  }

  handle(frame: OmoRpcFrame): void {
    if (!frame.toolCallId || !frame.toolName) return;
    const itemId = RuntimeItemId.make(frame.toolCallId);
    const result = frame.result ?? frame.partialResult;
    const detail = result?.content?.flatMap((block) => (block.text ? [block.text] : [])).join("\n");
    const payload = {
      itemType: itemType(frame.toolName),
      title: frame.toolName,
      ...(detail ? { detail } : {}),
      data: result ?? frame.args,
    };
    switch (frame.type) {
      case "tool_execution_start":
        this.emit({ type: "item.started", itemId, payload: { ...payload, status: "inProgress" } });
        break;
      case "tool_execution_update":
        this.emit({ type: "item.updated", itemId, payload: { ...payload, status: "inProgress" } });
        break;
      case "tool_execution_end":
        this.emit({
          type: "item.completed",
          itemId,
          payload: { ...payload, status: frame.isError ? "failed" : "completed" },
        });
        break;
      default:
        return;
    }
    const details = result?.details;
    if (!details) return;
    if (frame.type === "tool_execution_end") this.handleWorkflowResult(details);
    if (frame.toolName === "task") {
      const startedAt = isoTime(record(details.progress)?.startedAt);
      this.emitTask(details, frame.toolCallId, startedAt);
    } else if (frame.toolName === "task_send" || frame.toolName === "task_cancel") {
      this.handleTaskControl(frame, details);
    }
  }

  private handleWorkflowResult(details: OmoRpcTaskDetails): void {
    const root = record(details);
    const nestedResult = record(root?.result);
    const snapshot = record(nestedResult?.snapshot) ?? record(root?.snapshot);
    const runId = text(snapshot?.runId);
    if (!snapshot || !runId) return;
    const normalized = {
      run_id: runId,
      run_key: text(snapshot.runKey) ?? runId,
      name: text(snapshot.name) ?? "Workflow",
      status: text(snapshot.status) ?? "running",
      created_at: snapshot.createdAt,
      updated_at: snapshot.completedAt ?? snapshot.startedAt ?? snapshot.createdAt,
      nodes: Array.isArray(snapshot.nodes)
        ? snapshot.nodes.map((value) => {
            const node = record(value);
            return {
              id: node?.id,
              label: node?.label,
              prompt: node?.prompt,
              state: node?.state,
              task_id: node?.taskId,
              attempt: node?.attempt,
              created_at: node?.createdAt,
              started_at: node?.startedAt,
              completed_at: node?.completedAt,
              run_stats: node?.runStats,
            };
          })
        : [],
      waves: Array.isArray(snapshot.waves)
        ? snapshot.waves.map((value) => {
            const wave = record(value);
            return { index: wave?.index, node_ids: wave?.nodeIds };
          })
        : [],
    };
    this.handleDagUpdated({ runs: [normalized] });
  }

  handleExtension(frame: OmoRpcFrame): void {
    if (frame.name === "omo.task.updated") {
      const data = record(frame.data);
      if (!Array.isArray(data?.tasks)) return;
      for (const value of data.tasks) {
        const task = record(value);
        if (!task || !text(task.task_id)) continue;
        const progress = record(task.live_progress);
        this.emitTask(
          {
            ...task,
            progress: progress
              ? { activity: text(progress.activity), startedAt: progress.started_at }
              : undefined,
          },
          undefined,
          isoTime(task.updated_at) ?? isoTime(progress?.started_at),
        );
      }
      return;
    }
    if (frame.name === "omo.dag.updated") this.handleDagUpdated(frame.data);
    else if (frame.name === "omo.dag.activity") this.handleDagActivity(frame.data);
  }

  private handleDagUpdated(value: unknown): void {
    const data = record(value);
    if (!Array.isArray(data?.runs)) return;
    for (const rawRun of data.runs) {
      const run = record(rawRun);
      const runId = text(run?.run_id);
      if (!run || !runId) continue;
      const name = text(run.name) ?? text(run.run_key) ?? "Workflow";
      const waves = Array.isArray(run.waves) ? run.waves : [];
      const phases = waves.flatMap((rawWave, ordinal) => {
        const wave = record(rawWave);
        const index = count(wave?.index) ?? ordinal;
        return [{ index, title: `Phase ${index + 1}` }];
      });
      const coordinatorId = RuntimeTaskId.make(runId);
      const linkage = {
        taskType: "local_workflow",
        title: name,
        workflowName: name,
        phases,
        runHandles: { runId },
      } as const;
      const status = text(run.status) ?? "pending";
      const at = isoTime(run.updated_at) ?? isoTime(run.created_at);
      if (!this.workflowStatus.has(runId)) {
        this.emit(
          {
            type: "task.started",
            payload: { taskId: coordinatorId, description: name, ...linkage },
          },
          isoTime(run.created_at) ?? at,
        );
      }
      if (this.workflowStatus.get(runId) !== status) {
        this.workflowStatus.set(runId, status);
        const terminal = terminalStatus(status);
        this.emit(
          terminal
            ? {
                type: "task.completed",
                payload: { taskId: coordinatorId, ...linkage, status: terminal, summary: name },
              }
            : {
                type: "task.progress",
                payload: {
                  taskId: coordinatorId,
                  ...linkage,
                  description: name,
                  summary: `Workflow ${status}`,
                  status: runtimeStatus(status),
                },
              },
          at,
        );
      }
      const phaseByNode = new Map<string, { index: number; title: string }>();
      for (let ordinal = 0; ordinal < waves.length; ordinal++) {
        const wave = record(waves[ordinal]);
        const index = count(wave?.index) ?? ordinal;
        for (const nodeId of Array.isArray(wave?.node_ids) ? wave.node_ids : []) {
          if (typeof nodeId === "string")
            phaseByNode.set(nodeId, { index, title: `Phase ${index + 1}` });
        }
      }
      if (!Array.isArray(run.nodes)) continue;
      for (let agentIndex = 0; agentIndex < run.nodes.length; agentIndex++) {
        const node = record(run.nodes[agentIndex]);
        const nativeTaskId = text(node?.task_id);
        const nodeId = text(node?.id);
        if (!node || !nativeTaskId || !nodeId) continue;
        const phase = phaseByNode.get(nodeId);
        const nodeTitle = text(node.label) ?? text(node.prompt) ?? nodeId;
        const memberLinkage = {
          taskType: "subagent",
          title: nodeTitle,
          parentAgentId: runId,
          workflowName: name,
          agentIndex,
          ...(phase ? { phaseIndex: phase.index, phaseTitle: phase.title } : {}),
          ...(count(node.attempt) !== undefined ? { attempt: count(node.attempt)! } : {}),
          runHandles: { runId },
        } as const;
        this.taskIdentity.set(nativeTaskId, { description: nodeTitle, ...memberLinkage });
        const nodeStatus = text(node.state) ?? "pending";
        const previous = this.workflowStatus.get(`${runId}:${nodeId}`);
        const memberId = RuntimeTaskId.make(nativeTaskId);
        const usage = taskUsage(node.run_stats);
        if (previous === undefined) {
          this.emit(
            {
              type: "task.started",
              payload: { taskId: memberId, description: nodeTitle, ...memberLinkage },
            },
            isoTime(node.started_at) ?? isoTime(node.created_at) ?? at,
          );
        }
        if (previous === nodeStatus) continue;
        this.workflowStatus.set(`${runId}:${nodeId}`, nodeStatus);
        const terminal =
          terminalStatus(nodeStatus) ?? (nodeStatus === "skipped" ? "stopped" : undefined);
        this.emit(
          terminal
            ? {
                type: "task.completed",
                payload: {
                  taskId: memberId,
                  ...memberLinkage,
                  status: terminal,
                  summary: nodeTitle,
                  ...(usage ? { typedUsage: usage } : {}),
                },
              }
            : {
                type: "task.progress",
                payload: {
                  taskId: memberId,
                  ...memberLinkage,
                  description: nodeTitle,
                  summary: nodeTitle,
                  status: runtimeStatus(nodeStatus),
                },
              },
          isoTime(node.completed_at) ?? isoTime(node.started_at) ?? at,
        );
      }
    }
  }

  private handleDagActivity(value: unknown): void {
    const activity = record(value);
    const runId = text(activity?.runId);
    const taskId = text(activity?.taskId);
    if (!activity || !runId || !taskId) return;
    const identity = this.taskIdentity.get(taskId);
    const description =
      identity?.description ?? text(activity.lastAssistantLine) ?? "Workflow agent";
    const { description: _, ...knownLinkage } = identity ?? { description };
    const summary = text(activity.lastAssistantLine) ?? text(activity.activity) ?? description;
    this.emit(
      {
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(taskId),
          taskType: "subagent",
          parentAgentId: runId,
          runHandles: { runId },
          ...knownLinkage,
          description,
          summary,
          status: "running",
          ...(text(activity.currentTool) ? { lastToolName: text(activity.currentTool)! } : {}),
        },
      },
      isoTime(activity.at),
    );
  }
}
