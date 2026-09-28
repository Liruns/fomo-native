/**
 * OmoDriver — native multi-session RPC chat with app-server capability probes.
 * Model profiles from `~/.omo/omo.jsonc` appear as extra models whose slug
 * resolves to the profile's first available model.
 *
 * @module provider/Drivers/OmoDriver
 */
import * as NodeOS from "node:os";

import {
  OmoSettings,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmoRpcAdapter } from "../Layers/OmoRpcAdapter.ts";
import {
  mapCodexModelCapabilities,
  parseCodexSkillsListResponse,
  withCodexAppServerClient,
} from "../Layers/CodexProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { defaultProviderContinuationIdentity } from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  parseGenericCliVersion,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  normalizeOmoAppServerMessage,
  omoBinaryCandidates,
  omoUserConfigPaths,
  parseOmoModelProfiles,
  type OmoModelProfile,
} from "../omoCompat.ts";

const DRIVER_KIND = ProviderDriverKind.make("omo");
const OMO_PACKAGE_NAME = "omo-ai";
const PROFILE_SLUG_PREFIX = "profile:";
const decodeOmoSettings = Schema.decodeSync(OmoSettings);
const decodeLenientConfig = Schema.decodeUnknownEffect(fromLenientJson(Schema.Unknown));

const OMO_PRESENTATION = {
  displayName: "OmO",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;

export function omoProfileSlug(name: string): string {
  return `${PROFILE_SLUG_PREFIX}${name}`;
}

export function resolveOmoModelId(
  slug: string,
  input: {
    readonly profiles: ReadonlyArray<OmoModelProfile>;
    readonly modelIds: ReadonlySet<string>;
  },
): string | undefined {
  if (!slug.startsWith(PROFILE_SLUG_PREFIX)) {
    return input.modelIds.has(slug) ? slug : undefined;
  }
  const name = slug.slice(PROFILE_SLUG_PREFIX.length);
  return input.profiles
    .find((profile) => profile.name === name)
    ?.models.find((model) => input.modelIds.has(model));
}

export function buildOmoModels(input: {
  readonly catalog: ReadonlyArray<CodexSchema.V2ModelListResponse__Model>;
  readonly profiles: ReadonlyArray<OmoModelProfile>;
}): ReadonlyArray<ServerProviderModel> {
  const byId = new Map(input.catalog.map((model) => [model.id, model]));
  const profileModels = input.profiles.map((profile): ServerProviderModel => {
    const first = byId.get(profile.models[0] ?? "");
    return {
      slug: omoProfileSlug(profile.name),
      name: profile.name,
      subProvider: "Profile",
      isCustom: false,
      capabilities: first
        ? mapCodexModelCapabilities(first)
        : createModelCapabilities({ optionDescriptors: [] }),
    };
  });
  const catalogModels = input.catalog
    .filter((model) => !model.hidden)
    .map((model): ServerProviderModel => {
      const separator = model.id.indexOf("/");
      return {
        slug: model.id,
        name: model.displayName || model.model,
        ...(separator > 0 ? { subProvider: model.id.slice(0, separator) } : {}),
        isCustom: false,
        capabilities: mapCodexModelCapabilities(model),
      };
    });
  const [firstProfile] = profileModels;
  if (firstProfile) {
    return [{ ...firstProfile, isDefault: true }, ...profileModels.slice(1), ...catalogModels];
  }
  const defaultIndex = catalogModels.findIndex((_, index) => input.catalog[index]?.isDefault);
  return catalogModels.map((model, index) =>
    index === Math.max(0, defaultIndex) ? { ...model, isDefault: true } : model,
  );
}

export type OmoDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/** An explicit setting wins; otherwise the bun global install, then PATH. */
const resolveOmoBinaryPath = Effect.fn("resolveOmoBinaryPath")(function* (
  configured: string,
  env: NodeJS.ProcessEnv,
) {
  if (configured !== "omo") return configured;
  const fileSystem = yield* FileSystem.FileSystem;
  const candidates = omoBinaryCandidates({
    platform: process.platform,
    env,
    homeDir: NodeOS.homedir(),
  });
  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }
  return configured;
});

const readOmoProfiles = Effect.fn("readOmoProfiles")(function* (env: NodeJS.ProcessEnv) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const configPath of omoUserConfigPaths(env, NodeOS.homedir())) {
    const raw = yield* fileSystem.readFileString(configPath).pipe(Effect.option);
    if (Option.isNone(raw)) continue;
    const parsed = yield* decodeLenientConfig(raw.value).pipe(Effect.option);
    return Option.isSome(parsed) ? parseOmoModelProfiles(parsed.value) : [];
  }
  return [];
});

export const OmoDriver: ProviderDriver<OmoSettings, OmoDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OmO",
    supportsMultipleInstances: false,
  },
  configSchema: OmoSettings,
  defaultConfig: (): OmoSettings => decodeOmoSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const binaryPath = yield* resolveOmoBinaryPath(config.binaryPath, processEnv);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = {
        enabled,
        binaryPath,
        homePath: "",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      };
      const provideFs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        );
      const profiles = () => provideFs(readOmoProfiles(processEnv));

      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        provideFs(
          resolveProviderMaintenanceCapabilitiesEffect(
            makePackageManagedProviderMaintenanceResolver({
              provider: DRIVER_KIND,
              npmPackageName: OMO_PACKAGE_NAME,
              nativeUpdate: { args: ["update"], isCommandPath: () => true },
            }),
            { binaryPath, env: processEnv },
          ),
        ),
      );

      const probe = Effect.gen(function* () {
        const { client, initialize } = yield* withCodexAppServerClient({
          binaryPath,
          cwd: process.cwd(),
          environment: processEnv,
          transformIncoming: normalizeOmoAppServerMessage,
        });
        const catalog: Array<CodexSchema.V2ModelListResponse__Model> = [];
        let cursor: string | null | undefined;
        do {
          const page: CodexSchema.V2ModelListResponse = yield* client.request(
            "model/list",
            cursor ? { cursor } : {},
          );
          catalog.push(...page.data);
          cursor = page.nextCursor;
        } while (cursor);
        const skillsResponse = yield* client.request("skills/list", { cwds: [process.cwd()] });
        // `omo --version` prints "omo 5.0.1 (engine: senpi …)"; the handshake only
        // carries the engine version, which never matches the omo-ai package.
        const versionCommand = yield* resolveSpawnCommand(binaryPath, ["--version"], {
          env: processEnv,
        });
        const versionOutput = yield* spawnAndCollect(
          binaryPath,
          ChildProcess.make(versionCommand.command, versionCommand.args, {
            env: processEnv,
            shell: versionCommand.shell,
          }),
        ).pipe(Effect.option);
        return {
          version:
            (Option.isSome(versionOutput)
              ? parseGenericCliVersion(versionOutput.value.stdout)
              : null) ??
            initialize.userAgent.match(/\/([^\s]+)/)?.[1] ??
            null,
          catalog,
          skills: parseCodexSkillsListResponse(skillsResponse, process.cwd()),
        };
      });

      const checkProvider = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        if (!enabled) {
          return buildServerProvider({
            presentation: OMO_PRESENTATION,
            enabled: false,
            checkedAt,
            models: [],
            probe: {
              installed: false,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: "OmO is disabled.",
            },
          });
        }
        const [probeResult, loadedProfiles] = yield* Effect.all(
          [
            probe.pipe(
              Effect.scoped,
              Effect.timeoutOption(Duration.millis(AUTH_PROBE_TIMEOUT_MS)),
              Effect.result,
            ),
            profiles(),
          ],
          { concurrency: "unbounded" },
        );
        if (Result.isFailure(probeResult) || Option.isNone(probeResult.success)) {
          return buildServerProvider({
            presentation: OMO_PRESENTATION,
            enabled: true,
            checkedAt,
            models: [],
            probe: {
              installed: Result.isSuccess(probeResult),
              version: null,
              status: "error",
              auth: { status: "unknown" },
              message: Result.isFailure(probeResult)
                ? `Could not start omo (\`${binaryPath}\`). Install it with \`bun add -g ${OMO_PACKAGE_NAME}\`.`
                : "Timed out while checking omo.",
            },
          });
        }
        const snapshot = probeResult.success.value;
        return buildServerProvider({
          presentation: OMO_PRESENTATION,
          enabled: true,
          checkedAt,
          models: buildOmoModels({ catalog: snapshot.catalog, profiles: loadedProfiles }),
          skills: snapshot.skills,
          slashCommands: [COMPACT_SLASH_COMMAND],
          probe: {
            installed: true,
            version: snapshot.version,
            status: "ready",
            auth: { status: "authenticated" },
          },
        });
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<typeof effectiveConfig>
      >({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () =>
          Effect.map(DateTime.now, (now) =>
            stampIdentity(
              buildServerProvider({
                presentation: OMO_PRESENTATION,
                enabled,
                checkedAt: DateTime.formatIso(now),
                models: [],
                probe: {
                  installed: false,
                  version: null,
                  status: "warning",
                  auth: { status: "unknown" },
                  message: "Connecting to omo…",
                },
              }),
            ),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenance) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenance, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OmO snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const models = snapshot.getSnapshot.pipe(Effect.map((value) => value.models));
      const resolveModel = (slug: string) =>
        Effect.all([models, profiles()]).pipe(
          Effect.map(([current, loaded]) =>
            resolveOmoModelId(slug, {
              profiles: loaded,
              modelIds: new Set(current.map((model) => model.slug)),
            }),
          ),
        );
      const adapter = yield* makeOmoRpcAdapter({
        instanceId,
        binaryPath,
        environment: processEnv,
        resolveModel,
        attachmentsDir: (yield* ServerConfig).attachmentsDir,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeCodexTextGeneration(effectiveConfig, processEnv, models, {
        omoPrintMode: true,
        resolveModel,
      });
      const snapshotForCwd = (cwd: string) =>
        Effect.all([
          snapshot.getSnapshot,
          withCodexAppServerClient({
            binaryPath,
            cwd,
            environment: processEnv,
            transformIncoming: normalizeOmoAppServerMessage,
          }).pipe(
            Effect.flatMap(({ client }) => client.request("skills/list", { cwds: [cwd] })),
            Effect.map((response): ReadonlyArray<ServerProviderSkill> =>
              parseCodexSkillsListResponse(response, cwd),
            ),
            Effect.scoped,
            Effect.timeout("20 seconds"),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ]).pipe(
          Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to probe omo skills for '${cwd}'`,
                cause,
              }),
          ),
        );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
