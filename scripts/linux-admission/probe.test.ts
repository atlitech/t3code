import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { ENVIRONMENT_PATH, probeServer } from "./probe.ts";

const release = "0.0.46-atli.4";

// A stand-in server answering GET / and the environment descriptor.
const probeStub = (stub: {
  readonly rootStatus: number;
  readonly environmentStatus: number;
  readonly serverVersion: string;
}) =>
  probeServer({ baseUrl: "", releaseVersion: release }).pipe(
    Effect.provide(
      HttpRouter.serve(
        Layer.mergeAll(
          HttpRouter.add(
            "GET",
            "/",
            HttpServerResponse.text("<!doctype html>", { status: stub.rootStatus }),
          ),
          HttpRouter.add(
            "GET",
            ENVIRONMENT_PATH,
            HttpServerResponse.text(
              `{"environmentId":"stub","serverVersion":"${stub.serverVersion}"}`,
              { status: stub.environmentStatus, contentType: "application/json" },
            ),
          ),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
    ),
  );

const verdicts = (checks: ReadonlyArray<{ readonly name: string; readonly passed: boolean }>) =>
  Object.fromEntries(checks.map((check) => [check.name, check.passed]));

it.effect("passes when / is 200 and the environment reports the release version", () =>
  Effect.gen(function* () {
    const checks = yield* probeStub({
      rootStatus: 200,
      environmentStatus: 200,
      serverVersion: release,
    });
    assert.deepStrictEqual(verdicts(checks), { root: true, "environment-version": true });
  }),
);

it.effect("fails the root check when / is not 200", () =>
  Effect.gen(function* () {
    const checks = yield* probeStub({
      rootStatus: 503,
      environmentStatus: 200,
      serverVersion: release,
    });
    assert.deepStrictEqual(verdicts(checks), { root: false, "environment-version": true });
    assert.include(checks[0]!.detail, "HTTP 503");
  }),
);

it.effect("fails the version check when the environment reports another version", () =>
  Effect.gen(function* () {
    const checks = yield* probeStub({
      rootStatus: 200,
      environmentStatus: 200,
      serverVersion: "0.0.46-atli.3",
    });
    assert.deepStrictEqual(verdicts(checks), { root: true, "environment-version": false });
    assert.include(checks[1]!.detail, "'0.0.46-atli.3'");
  }),
);

it.effect("fails the version check when the environment endpoint is not 200", () =>
  Effect.gen(function* () {
    const checks = yield* probeStub({
      rootStatus: 200,
      environmentStatus: 500,
      serverVersion: release,
    });
    assert.deepStrictEqual(verdicts(checks), { root: true, "environment-version": false });
  }),
);
