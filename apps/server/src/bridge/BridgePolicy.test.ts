import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { isolateProviderIdentity } from "./BridgeProviderIdentity.ts";
import { isPublicProviderAddress, providerConnectHost } from "./BridgeEgress.ts";

vi.stubEnv("T3CODE_BRIDGE_PROFILE", "/operator/profile.json");
const policy = await import("./BridgePolicy.ts");
const runtime = await import("./BridgeRuntime.ts");
const codex = await import("../orchestration-v2/Adapters/CodexAdapterV2.ts");
const loggers = await import("../provider/ProviderEventLoggers.ts");
const settings = Schema.decodeSync(CodexSettings)({});
vi.unstubAllEnvs();

describe("bridge custody policy", () => {
  it.effect("denies unconfined Effect execution before the supplied spawner runs", () =>
    Effect.gen(function* () {
      let invoked = false;
      const raw = ChildProcessSpawner.make(() => {
        invoked = true;
        return Effect.die("unexpected spawn");
      });
      const result = yield* Effect.gen(function* () {
        const guarded = yield* ChildProcessSpawner.ChildProcessSpawner;
        return yield* guarded.spawn(ChildProcess.make("git", ["status"])).pipe(Effect.result);
      }).pipe(
        Effect.scoped,
        Effect.provide(policy.layerGuardedSpawner),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, raw),
      );
      expect(result._tag).toBe("Failure");
      expect(invoked).toBe(false);
      if (result._tag === "Failure")
        expect(policy.bridgeFailure(result.failure)?.reason).toBe("unconfined-execution");
    }),
  );

  it.effect(
    "routes supported Codex workspace sessions to the private factory without a host spawn",
    () =>
      Effect.gen(function* () {
        const opened: string[] = [];
        const refused = new policy.BridgeIsolationUnavailable({ reason: "runtime-failed" });
        const result = yield* Effect.gen(function* () {
          const factory = yield* codex.CodexAppServerClientFactory;
          return yield* factory
            .open({
              instanceId: ProviderInstanceId.make("codex"),
              threadId: ThreadId.make("a"),
              providerSessionId: ProviderSessionId.make("session-a"),
              settings,
              environment: {},
              runtimePolicy: {
                runtimeMode: "auto-accept-edits",
                interactionMode: "default",
                cwd: "/workspaces/a",
              },
            })
            .pipe(Effect.result);
        }).pipe(
          Effect.scoped,
          Effect.provide(codex.layerAppServerClientFactory),
          Effect.provideService(
            runtime.BridgeRuntime,
            runtime.BridgeRuntime.of({
              open: (input) => {
                opened.push(input.workspace);
                return Effect.fail(refused);
              },
            }),
          ),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("host spawn")),
          ),
          Effect.provideService(loggers.ProviderEventLoggers, loggers.NoOpProviderEventLoggers),
        );
        expect(opened).toEqual(["/workspaces/a"]);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(policy.bridgeFailure(result.failure)).toBe(refused);
      }),
  );

  it.effect("refuses read-only turn policy rather than broadening its workspace writes", () =>
    Effect.gen(function* () {
      const result = yield* codex
        .buildCodexTurnStartParams({
          nativeThreadId: "native",
          codexInput: [],
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: "/workspaces/a",
          },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toContain(
          "BridgeIsolationUnavailable:unsupported-runtime-settings",
        );
    }),
  );

  it.effect(
    "separates identical native identities across threads and preserves restart identity",
    () =>
      Effect.gen(function* () {
        const base = yield* IdAllocator.IdAllocatorV2.pipe(Effect.provide(IdAllocator.layer));
        const a = isolateProviderIdentity(base, "a").derive;
        const b = isolateProviderIdentity(base, "b").derive;
        const restarted = isolateProviderIdentity(base, "a").derive;
        const driver = ProviderDriverKind.make("codex");
        const item = { driver, nativeItemId: "same" };
        expect(a.providerThread({ driver, nativeThreadId: "same" })).not.toBe(
          b.providerThread({ driver, nativeThreadId: "same" }),
        );
        expect(a.providerTurn({ driver, nativeTurnId: "same" })).not.toBe(
          b.providerTurn({ driver, nativeTurnId: "same" }),
        );
        expect(a.nodeFromProviderItem(item)).not.toBe(b.nodeFromProviderItem(item));
        expect(a.messageFromProviderItem(item)).not.toBe(b.messageFromProviderItem(item));
        expect(a.turnItemFromProviderItem(item)).not.toBe(b.turnItemFromProviderItem(item));
        expect(a.nodeFromProviderItem(item)).toBe(restarted.nodeFromProviderItem(item));
      }),
  );

  it("only authorizes exact provider CONNECT authorities and public literal addresses", () => {
    expect(providerConnectHost("CONNECT api.openai.com:443 HTTP/1.1\r\n\r\n")).toBe(
      "api.openai.com",
    );
    for (const host of [
      "localhost",
      "github.com",
      "api.openai.com.evil",
      "127.0.0.1",
      "API.OPENAI.COM",
      "user@api.openai.com",
    ])
      expect(providerConnectHost(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`)).toBeUndefined();
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "100.64.0.1",
      "::1",
      "::ffff:8.8.8.8",
      "192.0.2.1",
      "224.0.0.1",
    ])
      expect(isPublicProviderAddress(address)).toBe(false);
    expect(isPublicProviderAddress("8.8.8.8")).toBe(true);
  });
});
