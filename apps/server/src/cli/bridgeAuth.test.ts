import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

const layers = Layer.mergeAll(NodeServices.layer, NetService.layer);

const invoke = (args: readonly string[], profile?: string) =>
  Effect.gen(function* () {
    vi.resetModules();
    if (profile === undefined) vi.stubEnv("T3CODE_BRIDGE_PROFILE", undefined);
    else vi.stubEnv("T3CODE_BRIDGE_PROFILE", profile);
    const { cli } = yield* Effect.promise(() => import("../binCli.ts"));
    const { bridgeFailure } = yield* Effect.promise(() => import("../bridge/BridgePolicy.ts"));
    vi.unstubAllEnvs();
    let spawned = false;
    const result = yield* Command.runWith(cli, { version: "0.0.0" })(["bridge-auth", ...args]).pipe(
      Effect.scoped,
      Effect.provide(layers),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawned = true;
          return Effect.die("Authentication attempted execution before admission");
        }),
      ),
      Effect.result,
    );
    expect(spawned).toBe(false);
    expect(result._tag).toBe("Failure");
    return result._tag === "Failure"
      ? { failure: result.failure, isolation: bridgeFailure(result.failure) }
      : undefined;
  });

describe("offline bridge-auth command admission", () => {
  it.effect("rejects an empty thread identity through the actual root CLI parser", () =>
    Effect.gen(function* () {
      const result = yield* invoke(["login", "--thread-id", "", "--workspace", "/workspaces/a"]);
      expect(result?.isolation).toBeUndefined();
      expect(result?.failure).toBeDefined();
    }),
  );

  it.effect("rejects relative and noncanonical workspace paths before runtime acquisition", () =>
    Effect.gen(function* () {
      for (const workspace of ["relative", "/workspaces/a/../b"]) {
        const result = yield* invoke(["login", "--thread-id", "a", "--workspace", workspace]);
        expect(result?.isolation?.reason).toBe("unsupported-workspace");
      }
    }),
  );

  it.effect("requires an operator profile for every authentication purpose", () =>
    Effect.gen(function* () {
      for (const purpose of ["login", "status", "logout"]) {
        const result = yield* invoke([purpose, "--thread-id", "a", "--workspace", "/workspaces/a"]);
        expect(result?.isolation?.reason).toBe("unsupported-topology");
      }
    }),
  );

  it.effect("refuses an untrusted deployment before constructing any namespace", () =>
    Effect.gen(function* () {
      const result = yield* invoke(
        ["login", "--thread-id", "a", "--workspace", "/workspaces/a"],
        "/tmp/untrusted-bridge-profile.json",
      );
      expect(result?.isolation?.reason).toBe("untrusted-deployment");
    }),
  );

  it.effect("provides no arbitrary executable, token or home flags", () =>
    Effect.gen(function* () {
      const result = yield* invoke([
        "login",
        "--thread-id",
        "a",
        "--workspace",
        "/workspaces/a",
        "--token",
        "synthetic",
      ]);
      expect(result?.isolation).toBeUndefined();
      expect(result?.failure).toBeDefined();
    }),
  );
});
