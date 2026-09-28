/**
 * Adapts `omo app-server` (a Codex app-server implementation) to the Codex
 * schemas T3 decodes, and resolves where the local omo install lives.
 *
 * omo differs from Codex on the wire in two ways that fail strict decoding:
 * it reports `*At` timestamps with fractional seconds, and its thread
 * records carry no `projectId`.
 *
 * @module provider/omoCompat
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

const FRACTIONAL_TIMESTAMP_KEY = /At$/;

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(record)) {
    next[key] =
      typeof field === "number" && !Number.isInteger(field) && FRACTIONAL_TIMESTAMP_KEY.test(key)
        ? Math.floor(field)
        : normalizeValue(field);
  }
  if ("preview" in next && "cwd" in next && !("projectId" in next)) {
    next.projectId = null;
  }
  return next;
}

export function normalizeOmoAppServerMessage(message: unknown): unknown {
  return normalizeValue(message);
}

export interface OmoModelProfile {
  readonly name: string;
  /** omo `provider/model` ids, in fallback order. */
  readonly models: ReadonlyArray<string>;
}

export function omoUserConfigPaths(env: NodeJS.ProcessEnv, homeDir: string) {
  const omoHome = NodePath.join(env.HOME ?? env.USERPROFILE ?? homeDir, ".omo");
  return [NodePath.join(omoHome, "omo.jsonc"), NodePath.join(omoHome, "omo.json")] as const;
}

export function parseOmoModelProfiles(config: unknown): ReadonlyArray<OmoModelProfile> {
  if (config === null || typeof config !== "object") return [];
  const profiles = (config as { model_profiles?: unknown }).model_profiles;
  if (profiles === null || typeof profiles !== "object") return [];
  return Object.entries(profiles as Record<string, unknown>).flatMap(([name, entry]) => {
    const models =
      entry !== null && typeof entry === "object"
        ? (entry as { models?: unknown }).models
        : undefined;
    const ids = Array.isArray(models)
      ? models.filter((model): model is string => typeof model === "string" && model.length > 0)
      : [];
    return ids.length > 0 ? [{ name, models: ids }] : [];
  });
}

/**
 * Candidate omo executables, most specific first. `bun add -g omo-ai` puts the
 * binary under `~/.bun/bin`, which a GUI-launched app often lacks on PATH.
 */
export function omoBinaryCandidates(input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
}): ReadonlyArray<string> {
  const executable = input.platform === "win32" ? "omo.exe" : "omo";
  const bunInstall = input.env.BUN_INSTALL?.trim();
  const directories = [
    ...(bunInstall ? [NodePath.join(bunInstall, "bin")] : []),
    NodePath.join(input.homeDir, ".bun", "bin"),
  ];
  return [...new Set(directories.map((directory) => NodePath.join(directory, executable)))];
}
