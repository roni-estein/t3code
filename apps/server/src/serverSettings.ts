/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderStartOptions,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  Cache,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  SchemaGetter,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "./config";

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

export interface ServerSettingsShape {
  /** Start the settings runtime and attach file watching. */
  readonly start: Effect.Effect<void, ServerSettingsError>;

  /** Await settings runtime readiness. */
  readonly ready: Effect.Effect<void, ServerSettingsError>;

  /** Read the current settings. */
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Patch settings and persist. Returns the new full settings object. */
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Stream of settings change events. */
  readonly streamChanges: Stream.Stream<ServerSettings>;
}

export class ServerSettingsService extends ServiceMap.Service<
  ServerSettingsService,
  ServerSettingsShape
>()("t3/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: Partial<ServerSettings> = {}) =>
    Layer.succeed(ServerSettingsService, {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, ...overrides }),
      updateSettings: () => Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, ...overrides }),
      streamChanges: Stream.empty,
    } satisfies ServerSettingsShape);
}

/**
 * Derive `ProviderStartOptions` from server settings.
 * Replaces the client-side `getProviderStartOptions()` function.
 */
export function deriveProviderStartOptions(
  settings: ServerSettings,
): ProviderStartOptions | undefined {
  const providerOptions: ProviderStartOptions = {
    ...(settings.providers.codex
      ? {
          codex: {
            ...(settings.providers.codex.binaryPath
              ? { binaryPath: settings.providers.codex.binaryPath }
              : {}),
            ...(settings.providers.codex.homePath
              ? { homePath: settings.providers.codex.homePath }
              : {}),
          },
        }
      : {}),
    ...(settings.providers.claudeAgent
      ? {
          claudeAgent: {
            binaryPath: settings.providers.claudeAgent.binaryPath,
          },
        }
      : {}),
  };

  return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
}

const ServerSettingsJson = Schema.fromJsonString(ServerSettings);
const PrettyJsonString = SchemaGetter.parseJson<string>().compose(
  SchemaGetter.stringifyJson({ space: 2 }),
);
const ServerSettingsPrettyJson = ServerSettingsJson.pipe(
  Schema.encode({
    decode: PrettyJsonString,
    encode: PrettyJsonString,
  }),
);

const makeServerSettings = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to check settings file existence",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to read settings file",
          cause,
        }),
    ),
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    if (!(yield* readConfigExists)) {
      return DEFAULT_SERVER_SETTINGS;
    }

    const raw = yield* readRawConfig;
    const decoded = Schema.decodeUnknownExit(ServerSettingsJson)(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("failed to parse settings.json, using defaults", {
        path: settingsPath,
      });
      return DEFAULT_SERVER_SETTINGS;
    }
    return decoded.value;
  });

  const settingsCache = yield* Cache.make<typeof cacheKey, ServerSettings, ServerSettingsError>({
    capacity: 1,
    lookup: () => loadSettingsFromDisk,
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

  const writeSettingsAtomically = (settings: ServerSettings) => {
    const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;

    return Schema.encodeEffect(ServerSettingsPrettyJson)(settings).pipe(
      Effect.map((encoded) => `${encoded}\n`),
      Effect.tap(() => fs.makeDirectory(pathService.dirname(settingsPath), { recursive: true })),
      Effect.tap((encoded) => fs.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fs.rename(tempPath, settingsPath)),
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to write settings file",
            cause,
          }),
      ),
    );
  };

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settings = yield* getSettingsFromCache;
      yield* emitChange(settings);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);
    const settingsFile = pathService.basename(settingsPath);
    const settingsPathResolved = pathService.resolve(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to prepare settings directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    yield* Stream.runForEach(fs.watch(settingsDir), (event) => {
      const isTargetEvent =
        event.path === settingsFile ||
        event.path === settingsPath ||
        pathService.resolve(settingsDir, event.path) === settingsPathResolved;
      if (!isTargetEvent) {
        return Effect.void;
      }
      return revalidateAndEmitSafely;
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(watcherScope), Effect.asVoid);
  });

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return yield* Deferred.await(startedDeferred);
    }

    yield* Ref.set(startedRef, true);
    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache,
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getSettingsFromCache;
          const next: ServerSettings = { ...current, ...patch };
          yield* writeSettingsAtomically(next);
          yield* Cache.set(settingsCache, cacheKey, next);
          yield* emitChange(next);
          return next;
        }),
      ),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings);
