/**
 * Optional integration check against a real `agent acp` install.
 * Enable with: T3_CURSOR_ACP_PROBE=1 bun run test --filter CursorAcpCliProbe
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { makeAcpJsonRpcConnection } from "./AcpJsonRpcConnection.ts";

describe.runIf(process.env.T3_CURSOR_ACP_PROBE === "1")("Cursor ACP CLI probe", () => {
  it.effect("initialize and authenticate against real agent acp", () =>
    Effect.gen(function* () {
      const conn = yield* makeAcpJsonRpcConnection({
        command: "agent",
        args: ["acp"],
        cwd: process.cwd(),
      });

      const init = yield* conn.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "t3-probe", version: "0.0.0" },
      });
      expect(init).toBeDefined();

      yield* conn.request("authenticate", { methodId: "cursor_login" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
