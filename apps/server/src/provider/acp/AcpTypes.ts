import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect";

import type { AcpError } from "./AcpErrors.ts";

/** JSON-RPC 2.0 error object on the wire. */
export const JsonRpcErrorPayload = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});

/** Parsed JSON object from one NDJSON line before JSON-RPC classification. */
export const JsonRpcInboundWire = Schema.Struct({
  jsonrpc: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(JsonRpcErrorPayload),
});

export const AcpInboundResponse = Schema.Struct({
  _tag: Schema.Literal("response"),
  id: Schema.Union([Schema.String, Schema.Number]),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(JsonRpcErrorPayload),
});

export const AcpInboundRequest = Schema.Struct({
  _tag: Schema.Literal("request"),
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});

export const AcpInboundNotification = Schema.Struct({
  _tag: Schema.Literal("notification"),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});

/**
 * Inbound JSON-RPC messages from the ACP agent (stdout), after line framing.
 */
export const AcpInboundMessage = Schema.Union([
  AcpInboundResponse,
  AcpInboundRequest,
  AcpInboundNotification,
]);

export type AcpInboundMessage = typeof AcpInboundMessage.Type;

const jsonRpcWireToInbound = SchemaTransformation.transformOrFail({
  decode: (parsed: typeof JsonRpcInboundWire.Type) => {
    const id = parsed.id;
    const method = parsed.method;
    const hasId = id !== undefined && id !== null;
    const hasMethod = typeof method === "string";

    if (hasId && (parsed.result !== undefined || parsed.error !== undefined)) {
      const err = parsed.error;
      const rpcError =
        err !== undefined
          ? {
              code: err.code,
              message: err.message,
              ...(err.data !== undefined ? { data: err.data } : {}),
            }
          : undefined;
      return Effect.succeed({
        _tag: "response" as const,
        id,
        ...(parsed.result !== undefined ? { result: parsed.result } : {}),
        ...(rpcError ? { error: rpcError } : {}),
      });
    }

    if (hasMethod && hasId) {
      return Effect.succeed({
        _tag: "request" as const,
        id,
        method,
        ...(parsed.params !== undefined ? { params: parsed.params } : {}),
      });
    }

    if (hasMethod && !hasId) {
      return Effect.succeed({
        _tag: "notification" as const,
        method,
        ...(parsed.params !== undefined ? { params: parsed.params } : {}),
      });
    }

    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(parsed), {
        title: "Unrecognized JSON-RPC inbound message shape",
      }),
    );
  },

  encode: (msg: AcpInboundMessage) => {
    if (msg._tag === "response") {
      return Effect.succeed({
        jsonrpc: "2.0" as const,
        id: msg.id,
        ...(msg.result !== undefined ? { result: msg.result } : {}),
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      });
    }
    if (msg._tag === "request") {
      return Effect.succeed({
        jsonrpc: "2.0" as const,
        id: msg.id,
        method: msg.method,
        ...(msg.params !== undefined ? { params: msg.params } : {}),
      });
    }
    return Effect.succeed({
      jsonrpc: "2.0" as const,
      method: msg.method,
      ...(msg.params !== undefined ? { params: msg.params } : {}),
    });
  },
});

const jsonRpcWireDecodedToInbound = JsonRpcInboundWire.pipe(
  Schema.decodeTo(Schema.toType(AcpInboundMessage), jsonRpcWireToInbound),
);

/** Decode one NDJSON line (JSON string) to a classified inbound message. */
export const AcpInboundFromJsonLine = Schema.fromJsonString(jsonRpcWireDecodedToInbound);

export const decodeAcpInboundFromJsonLine = Schema.decodeEffect(AcpInboundFromJsonLine);

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  /** Merged with `process.env` for the child. */
  readonly env?: Readonly<Record<string, string>>;
}

export type AcpServerRequestHandler = (
  params: unknown,
  requestId: number | string,
) => Effect.Effect<unknown, AcpError>;
