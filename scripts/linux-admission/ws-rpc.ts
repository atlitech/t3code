// Fork-only (atlitech/t3code). The smallest client of a T3 server's /ws RPC
// the Linux admission needs: one request per connection, in Effect RPC's JSON
// frames (`Request` out; `Chunk`, acknowledged with `Ack`, and `Exit` back).
// It authenticates the way the web client does, with a bearer token traded
// for a one-time `wsTicket`.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Socket } from "effect/socket";

// /ws serves only clients that speak orchestration protocol 2.
const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
const ORCHESTRATION_PROTOCOL_VERSION = "2";

/** What one request produced: the streamed values, and how it ended. */
export interface RpcOutcome {
  readonly values: ReadonlyArray<unknown>;
  /** The request's `Exit` frame, or undefined when `until` ended it first. */
  readonly exit: unknown;
}

export class WsRpcError extends Schema.TaggedError<WsRpcError>()("WsRpcError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `The server's /ws RPC failed: ${this.detail}`;
  }
}

const decodeTicket = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ ticket: Schema.String })),
);
const encodeFrame = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.String,
      requestId: Schema.optional(Schema.Unknown),
      values: Schema.optional(Schema.Array(Schema.Unknown)),
      exit: Schema.optional(Schema.Unknown),
    }),
  ),
);

/**
 * Sends one RPC and collects its streamed values until `until` accepts one
 * (that value is not collected) or the server ends the request.
 */
export const callRpc = Effect.fn("callRpc")(
  function* (options: {
    readonly baseUrl: string;
    readonly token: string;
    readonly tag: string;
    readonly payload: unknown;
    readonly until?: (value: unknown) => boolean;
  }) {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)),
    );
    const ticketResponse = yield* client.execute(
      HttpClientRequest.post("/api/auth/websocket-ticket").pipe(
        HttpClientRequest.bearerToken(options.token),
      ),
    );
    const { ticket } = yield* decodeTicket(yield* ticketResponse.text);
    const url = new URL("/ws", options.baseUrl.replace(/^http/, "ws"));
    url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION);
    url.searchParams.set("wsTicket", ticket);

    const socket = yield* Socket.makeWebSocket(url.toString(), {
      openTimeout: Duration.seconds(10),
    });
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    const send = (frame: unknown) => Effect.flatMap(encodeFrame(frame), writer.write);
    yield* send({
      _tag: "Request",
      id: "1",
      tag: options.tag,
      headers: [],
      payload: options.payload,
    });
    const textDecoder = new TextDecoder();
    const values: Array<unknown> = [];
    while (true) {
      for (const raw of yield* reader.pull) {
        const frame = yield* decodeFrame(typeof raw === "string" ? raw : textDecoder.decode(raw));
        if (frame._tag === "Ping") {
          yield* send({ _tag: "Pong" });
        } else if (frame._tag === "Chunk") {
          yield* send({ _tag: "Ack", requestId: frame.requestId });
          for (const value of frame.values ?? []) {
            if (options.until?.(value) === true) {
              return { values, exit: undefined } satisfies RpcOutcome;
            }
            values.push(value);
          }
        } else if (frame._tag !== "Pong") {
          // Exit, or a protocol-level Defect: the request is over.
          return { values, exit: frame } satisfies RpcOutcome;
        }
      }
    }
  },
  Effect.scoped,
  Effect.timeout(Duration.seconds(30)),
  Effect.mapError((cause) => new WsRpcError({ detail: cause.message })),
);

/** `thread.create` and friends answer `Exit` with `{ _tag: "Success" }` when accepted. */
export const isSuccessExit = Schema.is(
  Schema.TaggedStruct("Exit", { exit: Schema.TaggedStruct("Success", {}) }),
);
