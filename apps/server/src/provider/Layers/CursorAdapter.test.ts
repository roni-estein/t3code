import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";

import { ApprovalRequestId, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { resolveCursorDispatchModel } from "@t3tools/shared/model";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { makeCursorAdapterLive } from "./CursorAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.mjs");

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-mock-"));
  const wrapperPath = path.join(dir, "fake-agent.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function makeProbeWrapper(
  requestLogPath: string,
  argvLogPath: string,
  extraEnv?: Record<string, string>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-probe-"));
  const wrapperPath = path.join(dir, "fake-agent.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
printf '%s\t' "$@" >> ${JSON.stringify(argvLogPath)}
printf '\n' >> ${JSON.stringify(argvLogPath)}
export T3_ACP_REQUEST_LOG_PATH=${JSON.stringify(requestLogPath)}
${envExports}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readArgvLog(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").filter((token) => token.length > 0));
}

async function readJsonLines(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const cursorAdapterTestLayer = it.layer(
  makeCursorAdapterLive().pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

cursorAdapterTestLayer("CursorAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.makeUnsafe("cursor-mock-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "default" },
      });

      assert.equal(session.provider, "cursor");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((e) => e.type);

      for (const t of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "content.delta",
        "turn.completed",
      ] as const) {
        assert.include(types, t);
      }

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      const planUpdate = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.isDefined(planUpdate);
      if (planUpdate?.type === "turn.plan.updated") {
        assert.deepStrictEqual(planUpdate.payload, {
          explanation: "Mock plan while in code",
          plan: [
            { step: "Inspect mock ACP state", status: "completed" },
            { step: "Implement the requested change", status: "inProgress" },
          ],
        });
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.makeUnsafe("bad-provider"),
          provider: "codex",
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("selects the Cursor model via CLI argv instead of ACP request payloads", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.makeUnsafe("cursor-model-probe");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const dispatchedModel = resolveCursorDispatchModel("composer-2", { fastMode: true });
      const session = yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "composer-2", options: { fastMode: true } },
      });

      assert.equal(session.model, "composer-2");

      yield* adapter.sendTurn({
        threadId,
        input: "probe model selection",
        attachments: [],
      });
      yield* adapter.stopSession(threadId);

      const argvRuns = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.deepStrictEqual(argvRuns, [["--model", dispatchedModel, "acp"]]);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests
        .map((entry) => entry.method)
        .filter((method): method is string => typeof method === "string");
      assert.includeMembers(methods, [
        "initialize",
        "authenticate",
        "session/new",
        "session/set_mode",
        "session/prompt",
      ]);

      for (const request of requests) {
        const params = request.params;
        if (params && typeof params === "object" && !Array.isArray(params)) {
          assert.isFalse(Object.prototype.hasOwnProperty.call(params, "model"));
        }
      }

      const promptRequest = requests.find((entry) => entry.method === "session/prompt");
      assert.isDefined(promptRequest);
      assert.deepStrictEqual(
        Object.keys((promptRequest?.params as Record<string, unknown>) ?? {}).toSorted(),
        ["prompt", "sessionId"],
      );

      const modeRequest = requests.find((entry) => entry.method === "session/set_mode");
      assert.isDefined(modeRequest);
      assert.deepStrictEqual(modeRequest?.params, {
        sessionId: "mock-session-1",
        modeId: "code",
      });
    }),
  );

  it.effect("maps app plan mode onto the ACP plan session mode", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.makeUnsafe("cursor-plan-mode-probe");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "plan this change",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeRequest = requests.find((entry) => entry.method === "session/set_mode");
      assert.isDefined(modeRequest);
      assert.deepStrictEqual(modeRequest?.params, {
        sessionId: "mock-session-1",
        modeId: "architect",
      });
    }),
  );

  it.effect("streams ACP tool calls and approvals on the active turn in real time", () =>
    Effect.gen(function* () {
      const previousEmitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS;
      process.env.T3_ACP_EMIT_TOOL_CALLS = "1";

      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.makeUnsafe("cursor-tool-call-probe");
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const settledEventTypes = new Set<string>();
      const settledEventsReady = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && event.requestId) {
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.makeUnsafe(String(event.requestId)),
              "accept",
            );
          }
          if (
            event.type === "turn.completed" ||
            event.type === "item.completed" ||
            event.type === "content.delta"
          ) {
            settledEventTypes.add(event.type);
            if (settledEventTypes.size === 3) {
              yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
            }
          }
        }),
      ).pipe(Effect.forkChild);

      const program = Effect.gen(function* () {
        yield* adapter.startSession({
          threadId,
          provider: "cursor",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { provider: "cursor", model: "default" },
        });

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "run a tool call",
          attachments: [],
        });
        yield* Deferred.await(settledEventsReady);

        const threadEvents = runtimeEvents.filter(
          (event) => String(event.threadId) === String(threadId),
        );
        assert.includeMembers(
          threadEvents.map((event) => event.type),
          [
            "session.started",
            "session.state.changed",
            "thread.started",
            "turn.started",
            "request.opened",
            "request.resolved",
            "item.updated",
            "item.completed",
            "content.delta",
            "turn.completed",
          ],
        );

        const turnEvents = threadEvents.filter(
          (event) => String(event.turnId) === String(turn.turnId),
        );
        const toolUpdates = turnEvents.filter((event) => event.type === "item.updated");
        assert.lengthOf(toolUpdates, 2);
        for (const toolUpdate of toolUpdates) {
          if (toolUpdate.type !== "item.updated") {
            continue;
          }
          assert.equal(toolUpdate.payload.itemType, "command_execution");
          assert.equal(toolUpdate.payload.status, "inProgress");
          assert.equal(toolUpdate.payload.detail, "cat server/package.json");
          assert.equal(String(toolUpdate.itemId), "tool-call-1");
        }

        const requestOpened = turnEvents.find((event) => event.type === "request.opened");
        assert.isDefined(requestOpened);
        if (requestOpened?.type === "request.opened") {
          assert.equal(String(requestOpened.turnId), String(turn.turnId));
          assert.equal(requestOpened.payload.requestType, "exec_command_approval");
          assert.equal(requestOpened.payload.detail, "cat server/package.json");
        }

        const requestResolved = turnEvents.find((event) => event.type === "request.resolved");
        assert.isDefined(requestResolved);
        if (requestResolved?.type === "request.resolved") {
          assert.equal(String(requestResolved.turnId), String(turn.turnId));
          assert.equal(requestResolved.payload.requestType, "exec_command_approval");
          assert.equal(requestResolved.payload.decision, "accept");
        }

        const toolCompleted = turnEvents.find((event) => event.type === "item.completed");
        assert.isDefined(toolCompleted);
        if (toolCompleted?.type === "item.completed") {
          assert.equal(String(toolCompleted.turnId), String(turn.turnId));
          assert.equal(toolCompleted.payload.itemType, "command_execution");
          assert.equal(toolCompleted.payload.status, "completed");
          assert.equal(toolCompleted.payload.detail, "cat server/package.json");
          assert.equal(String(toolCompleted.itemId), "tool-call-1");
        }

        const contentDelta = turnEvents.find((event) => event.type === "content.delta");
        assert.isDefined(contentDelta);
        if (contentDelta?.type === "content.delta") {
          assert.equal(String(contentDelta.turnId), String(turn.turnId));
          assert.equal(contentDelta.payload.delta, "hello from mock");
        }
      });

      yield* program.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousEmitToolCalls === undefined) {
              delete process.env.T3_ACP_EMIT_TOOL_CALLS;
            } else {
              process.env.T3_ACP_EMIT_TOOL_CALLS = previousEmitToolCalls;
            }
          }),
        ),
      );
    }).pipe(
      Effect.provide(
        makeCursorAdapterLive().pipe(
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("restarts ACP with session/load when the Cursor model changes mid-thread", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.makeUnsafe("cursor-model-restart");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });

      yield* adapter.sendTurn({
        threadId,
        input: "second turn after switching model",
        attachments: [],
        modelSelection: { provider: "cursor", model: "composer-2", options: { fastMode: true } },
      });

      const argvRuns = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.deepStrictEqual(argvRuns, [
        ["--model", "composer-2", "acp"],
        ["--model", "composer-2-fast", "acp"],
      ]);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const loadRequests = requests.filter((entry) => entry.method === "session/load");
      assert.lengthOf(loadRequests, 1);
      assert.deepStrictEqual(loadRequests[0]?.params, {
        sessionId: "mock-session-1",
        cwd: process.cwd(),
        mcpServers: [],
      });

      yield* adapter.stopSession(threadId);
    }),
  );
});
