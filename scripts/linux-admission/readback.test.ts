// @effect-diagnostics nodeBuiltinImport:off - Reads the committed fixtures and recording.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { Socket } from "effect/socket";

import { readback } from "./readback.ts";

// A stand-in candidate that answers with the committed recording: the thread
// snapshots over HTTP, and both resumes over /ws in Effect RPC's JSON frames.
const here = import.meta.dirname;
const read = (file: string) => NodeFS.readFileSync(NodePath.join(here, file), "utf8");
const recorded = JSON.parse(read("snapshot-response.json")) as {
  seededEvents: Array<unknown>;
  snapshots: Array<{ threadId: string; body: unknown }>;
  threadReplays: Array<{ threadId: string; values: Array<unknown> }>;
  shellReplay: { values: Array<unknown> };
};

const TOKEN = "stand-in-bearer-7f3c9a1e5b2d4c6a8e0f";

const stubCandidate = Layer.mergeAll(
  HttpRouter.add("POST", "/api/auth/websocket-ticket", (request) =>
    Effect.succeed(
      request.headers.authorization === `Bearer ${TOKEN}`
        ? HttpServerResponse.text(JSON.stringify({ ticket: "stand-in-ticket" }))
        : HttpServerResponse.text("unauthorized", { status: 401 }),
    ),
  ),
  HttpRouter.add("GET", "/api/orchestration/threads/:threadId", (request) =>
    Effect.succeed(
      HttpServerResponse.text(
        JSON.stringify(
          recorded.snapshots.find((snapshot) => request.url.endsWith(`/${snapshot.threadId}`))
            ?.body,
        ),
      ),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/ws",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* request.upgrade;
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const [frame] = yield* reader.pull;
      const call = JSON.parse(String(frame)) as {
        tag: string;
        payload: { threadId?: string };
      };
      const values =
        call.tag === "orchestration.subscribeShell"
          ? recorded.shellReplay.values
          : recorded.threadReplays.find((replay) => replay.threadId === call.payload.threadId)!
              .values;
      yield* writer.write(
        JSON.stringify({
          _tag: "Chunk",
          requestId: "1",
          values: [...values, { kind: "synchronized" }],
        }),
      );
      // Hold the stream open, as a live subscription does, until the client leaves.
      yield* Effect.ignore(Effect.forever(reader.pull));
      return HttpServerResponse.empty();
    }).pipe(Effect.scoped, Effect.orDie),
  ),
);

it.layer(NodeServices.layer)("readback", (it) => {
  it.effect("reads a candidate back without its bearer token in anything it writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "admission-readback-" });
      const file = (name: string) => path.join(dir, name);
      yield* fs.writeFileString(file("token"), `${TOKEN}\n`);
      yield* fs.writeFileString(file("seeded-events.json"), JSON.stringify(recorded.seededEvents));

      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      assert.isTrue("port" in address, address._tag);
      const port = "port" in address ? address.port : 0;
      yield* readback({
        stage: "upgraded",
        baseUrl: `http://localhost:${port}`,
        tokenFile: file("token"),
        fixtures: path.join(here, "fixtures.json"),
        seededEvents: file("seeded-events.json"),
        out: file("readback.json"),
        responsesOut: Option.some(file("responses.json")),
      }).pipe(
        Effect.provide(Layer.merge(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
      );

      const result = JSON.parse(yield* fs.readFileString(file("readback.json")));
      assert.isTrue(result.passed);
      for (const name of ["readback.json", "responses.json"]) {
        assert.notInclude(yield* fs.readFileString(file(name)), TOKEN, name);
      }
    }).pipe(
      Effect.provide(
        HttpRouter.serve(stubCandidate, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      ),
    ),
  );
});
