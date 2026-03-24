import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { ThreadId } from "@t3tools/contracts";
import { resolveCursorDispatchModel } from "@t3tools/shared/model";

import { ServerConfig } from "../src/config.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { CursorAdapter } from "../src/provider/Services/CursorAdapter.ts";
import { makeCursorAdapterLive } from "../src/provider/Layers/CursorAdapter.ts";

const scriptDir = import.meta.dir;
const mockAgentPath = path.join(scriptDir, "acp-mock-agent.mjs");

function parseArgs(argv: string[]) {
  const args = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, true);
      continue;
    }
    args.set(key, next);
    index += 1;
  }
  return args;
}

async function makeProbeWrapper(requestLogPath: string, argvLogPath: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-probe-script-"));
  const wrapperPath = path.join(dir, "fake-agent.sh");
  const script = `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(argvLogPath)}
export T3_ACP_REQUEST_LOG_PATH=${JSON.stringify(requestLogPath)}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const cliArgs = parseArgs(process.argv.slice(2));
const model =
  typeof cliArgs.get("model") === "string" ? String(cliArgs.get("model")) : "composer-2";
const fastMode = cliArgs.get("fast") === true;

const layer = makeCursorAdapterLive().pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

const program = Effect.gen(function* () {
  const adapter = yield* CursorAdapter;
  const serverSettings = yield* ServerSettingsService;
  const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-probe-")));
  const requestLogPath = path.join(tempDir, "requests.ndjson");
  const argvLogPath = path.join(tempDir, "argv.txt");
  yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
  const wrapperPath = yield* Effect.promise(() => makeProbeWrapper(requestLogPath, argvLogPath));
  const threadId = ThreadId.makeUnsafe("cursor-acp-model-selection-probe");
  const cursorModelOptions = fastMode ? { fastMode: true as const } : undefined;
  const dispatchedModel = resolveCursorDispatchModel(model, cursorModelOptions);

  yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

  yield* adapter.startSession({
    threadId,
    provider: "cursor",
    cwd: process.cwd(),
    runtimeMode: "full-access",
    modelSelection: {
      provider: "cursor",
      model,
      ...(cursorModelOptions ? { options: cursorModelOptions } : {}),
    },
  });

  yield* adapter.sendTurn({
    threadId,
    input: "probe model selection",
    attachments: [],
  });
  yield* adapter.stopSession(threadId);

  const argv = (yield* Effect.promise(() => readFile(argvLogPath, "utf8")))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
  const promptRequest = requests.find((entry) => entry.method === "session/prompt");
  const promptParams =
    promptRequest?.params &&
    typeof promptRequest.params === "object" &&
    !Array.isArray(promptRequest.params)
      ? promptRequest.params
      : null;

  return {
    input: {
      model,
      fastMode,
    },
    dispatchedModel,
    spawnedArgv: argv,
    acpMethods: requests
      .map((entry) => entry.method)
      .filter((method): method is string => typeof method === "string"),
    promptParams,
    promptCarriesModel: Boolean(
      promptParams && Object.prototype.hasOwnProperty.call(promptParams, "model"),
    ),
    conclusion:
      "Cursor model selection is decided before ACP initialize via CLI argv. The ACP session/prompt payload does not carry a model field.",
  };
}).pipe(Effect.provide(layer));

const result = await Effect.runPromise(program);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
