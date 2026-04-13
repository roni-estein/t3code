import { describe, it, assert } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";
import { Effect, Fiber, PubSub, Ref, Stream } from "effect";

import { makeManagedServerProvider } from "./makeManagedServerProvider";

interface TestSettings {
  readonly enabled: boolean;
}

const initialSnapshot: ServerProvider = {
  provider: "codex",
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};

const refreshedSnapshot: ServerProvider = {
  provider: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("makeManagedServerProvider", () => {
  it.effect("keeps the initial snapshot until an explicit refresh runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const provider = yield* makeManagedServerProvider<TestSettings>({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => initialSnapshot,
          checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 hour",
        });

        const initial = yield* provider.getSnapshot;
        const beforeRefresh = yield* provider.getSnapshot;
        assert.deepStrictEqual(initial, initialSnapshot);
        assert.deepStrictEqual(beforeRefresh, initialSnapshot);
        assert.strictEqual(yield* Ref.get(checkCalls), 0);

        const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const refreshed = yield* provider.refresh;
        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(refreshed, refreshedSnapshot);
        assert.deepStrictEqual(updates, [refreshedSnapshot]);
        assert.deepStrictEqual(latest, refreshedSnapshot);
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ),
  );

  it.effect("reruns the provider check when streamed settings change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsRef = yield* Ref.make<TestSettings>({ enabled: true });
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const provider = yield* makeManagedServerProvider<TestSettings>({
          getSettings: Ref.get(settingsRef),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => initialSnapshot,
          checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Ref.set(settingsRef, { enabled: false });
        yield* PubSub.publish(settingsChanges, { enabled: false });

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot]);
        assert.deepStrictEqual(latest, refreshedSnapshot);
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ),
  );
});
