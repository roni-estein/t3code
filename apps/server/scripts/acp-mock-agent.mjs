#!/usr/bin/env node
/**
 * Minimal NDJSON JSON-RPC "agent" for ACP client tests.
 * Reads stdin lines; writes responses/notifications to stdout.
 */
import * as readline from "node:readline";
import { appendFileSync } from "node:fs";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
const sessionId = "mock-session-1";
let currentModeId = "ask";
let nextRequestId = 1;
const availableModes = [
  {
    id: "ask",
    name: "Ask",
    description: "Request permission before making any changes",
  },
  {
    id: "architect",
    name: "Architect",
    description: "Design and plan software systems without implementation",
  },
  {
    id: "code",
    name: "Code",
    description: "Write and modify code with full tool access",
  },
];
const pendingPermissionRequests = new Map();

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function modeState() {
  return {
    currentModeId,
    availableModes,
  };
}

function sendSessionUpdate(update, session = sessionId) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: session,
      update,
    },
  });
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  if (requestLogPath) {
    appendFileSync(requestLogPath, `${JSON.stringify(msg)}\n`, "utf8");
  }

  const id = msg.id;
  const method = msg.method;

  if (method === undefined && id !== undefined && pendingPermissionRequests.has(id)) {
    const pending = pendingPermissionRequests.get(id);
    pendingPermissionRequests.delete(id);
    sendSessionUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: pending.toolCallId,
        title: "Terminal",
        kind: "execute",
        status: "completed",
        rawOutput: {
          exitCode: 0,
          stdout: '{ "name": "t3" }',
          stderr: "",
        },
      },
      pending.sessionId,
    );
    sendSessionUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello from mock" },
      },
      pending.sessionId,
    );
    send({
      jsonrpc: "2.0",
      id: pending.promptRequestId,
      result: { stopReason: "end_turn" },
    });
    return;
  }

  if (method === "initialize" && id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    return;
  }

  if (method === "authenticate" && id !== undefined) {
    send({ jsonrpc: "2.0", id, result: { authenticated: true } });
    return;
  }

  if (method === "session/new" && id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId,
        modes: modeState(),
      },
    });
    return;
  }

  if (method === "session/load" && id !== undefined) {
    const requestedSessionId = msg.params?.sessionId ?? sessionId;
    sendSessionUpdate(
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "replay" },
      },
      requestedSessionId,
    );
    send({
      jsonrpc: "2.0",
      id,
      result: {
        modes: modeState(),
      },
    });
    return;
  }

  if (method === "session/prompt" && id !== undefined) {
    const requestedSessionId = msg.params?.sessionId ?? sessionId;
    if (emitToolCalls) {
      const toolCallId = "tool-call-1";
      const permissionRequestId = nextRequestId++;
      sendSessionUpdate(
        {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Terminal",
          kind: "execute",
          status: "pending",
          rawInput: {
            command: ["cat", "server/package.json"],
          },
        },
        requestedSessionId,
      );
      sendSessionUpdate(
        {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
        },
        requestedSessionId,
      );
      pendingPermissionRequests.set(permissionRequestId, {
        promptRequestId: id,
        sessionId: requestedSessionId,
        toolCallId,
      });
      send({
        jsonrpc: "2.0",
        id: permissionRequestId,
        method: "session/request_permission",
        params: {
          sessionId: requestedSessionId,
          toolCall: {
            toolCallId,
            title: "`cat server/package.json`",
            kind: "execute",
            status: "pending",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Not in allowlist: cat server/package.json",
                },
              },
            ],
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    sendSessionUpdate(
      {
        sessionUpdate: "plan",
        explanation: `Mock plan while in ${currentModeId}`,
        entries: [
          {
            content: "Inspect mock ACP state",
            priority: "high",
            status: "completed",
          },
          {
            content: "Implement the requested change",
            priority: "high",
            status: "in_progress",
          },
        ],
      },
      requestedSessionId,
    );
    sendSessionUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello from mock" },
      },
      requestedSessionId,
    );
    send({
      jsonrpc: "2.0",
      id,
      result: { stopReason: "end_turn" },
    });
    return;
  }

  if ((method === "session/set_mode" || method === "session/mode/set") && id !== undefined) {
    const nextModeId =
      typeof msg.params?.modeId === "string"
        ? msg.params.modeId
        : typeof msg.params?.mode === "string"
          ? msg.params.mode
          : undefined;
    if (typeof nextModeId === "string" && nextModeId.trim()) {
      currentModeId = nextModeId.trim();
      sendSessionUpdate({
        sessionUpdate: "current_mode_update",
        currentModeId,
      });
    }
    send({ jsonrpc: "2.0", id, result: null });
    return;
  }

  if (method === "session/cancel" && id !== undefined) {
    send({ jsonrpc: "2.0", id, result: null });
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unhandled method: ${String(method)}` },
    });
  }
});
