import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.stubEnv("T3CODE_BRIDGE_PROFILE", "/operator/profile.json");
const policy = await import("./BridgePolicy.ts");
const processRunner = await import("../processRunner.ts");
const nodePty = await import("../terminal/NodePtyAdapter.ts");
const terminals = await import("../terminal/Manager.ts");
const setupScripts = await import("../project/ProjectSetupScriptRunner.ts");
const projects = await import("../project/ProjectService.ts");
const settings = await import("../serverSettings.ts");
const gitCore = await import("../vcs/GitVcsDriverCore.ts");
const git = await import("../vcs/GitVcsDriver.ts");
const vcsProcess = await import("../vcs/VcsProcess.ts");
const config = await import("../config.ts");
const providers = await import("../provider/ProviderInstanceRegistry.ts");
vi.unstubAllEnvs();

const hostSpawn = vi.fn(() => Effect.die("Unexpected host child process"));
const spawner = ChildProcessSpawner.make(hostSpawn);
const nativeSpawn = vi.fn(() => {
  throw new Error("Unexpected native PTY process");
});
const fakeNativePty = { spawn: nativeSpawn } as unknown as typeof import("node-pty");
const hostLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(HostProcessPlatform, "linux"),
  Layer.succeed(HostProcessArchitecture, "x64"),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  Layer.succeed(nodePty.NodePtyModuleLoaderRef, () => Promise.resolve(fakeNativePty)),
);

const terminalFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bridge-execution-" });
  const adapter = yield* nodePty.make();
  const runner = yield* processRunner.make();
  const manager = yield* terminals
    .makeWithOptions({
      logsDir: `${cwd}/logs`,
      ptyAdapter: adapter,
      shellResolver: () => "/bin/sh",
      env: {},
      processTable: Effect.succeed([]),
    })
    .pipe(Effect.provideService(processRunner.ProcessRunner, runner));
  return { manager, fs, cwd };
});

describe("bridge server execution refusals", () => {
  it.effect("refuses the native PTY adapter even when called without TerminalManager", () =>
    Effect.gen(function* () {
      nativeSpawn.mockClear();
      yield* Effect.gen(function* () {
        const adapter = yield* nodePty.make();
        const failure = yield* adapter
          .spawn({ shell: "/bin/sh", cwd: "/missing/workspace", cols: 80, rows: 24, env: {} })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("PtySpawnError");
        expect(policy.bridgeFailure(failure)?.reason).toBe("unconfined-execution");
      }).pipe(Effect.provide(hostLayer));
      expect(nativeSpawn).not.toHaveBeenCalled();
    }),
  );

  it.effect("refuses a direct terminal before node-pty can create a shell", () =>
    Effect.gen(function* () {
      nativeSpawn.mockClear();
      hostSpawn.mockClear();
      yield* Effect.gen(function* () {
        const { manager, cwd } = yield* terminalFixture;
        const failure = yield* manager
          .open({ threadId: "direct", terminalId: "shell", cwd })
          .pipe(Effect.flip);
        expect(policy.bridgeFailure(failure)?.reason).toBe("unconfined-execution");
      }).pipe(Effect.scoped, Effect.provide(hostLayer));
      expect(nativeSpawn).not.toHaveBeenCalled();
      expect(hostSpawn).not.toHaveBeenCalled();
    }),
  );

  it.effect.each(["setup", "settle"] as const)(
    "refuses a %s script through the real terminal manager before writing its command",
    (trigger) =>
      Effect.gen(function* () {
        nativeSpawn.mockClear();
        hostSpawn.mockClear();
        yield* Effect.gen(function* () {
          const { manager, fs, cwd } = yield* terminalFixture;
          const runner = yield* setupScripts.make.pipe(
            Effect.provideService(terminals.TerminalManager, manager),
            Effect.provide(
              Layer.mergeAll(Layer.mock(projects.ProjectService)({}), settings.layerTest()),
            ),
          );
          const failure = yield* runner
            .runForThread({
              threadId: "script",
              worktreePath: cwd,
              trigger,
              project: {
                id: ProjectId.make("bridge-project"),
                workspaceRoot: cwd,
                scripts: [
                  {
                    id: "script",
                    name: "Script",
                    icon: "configure",
                    command: "printf host-side-effect > setup-marker",
                    runOnWorktreeCreate: true,
                    runOnSettle: true,
                  },
                ],
              },
            })
            .pipe(Effect.flip);
          expect(failure._tag).toBe("ProjectSetupScriptOperationError");
          if (failure._tag === "ProjectSetupScriptOperationError")
            expect(failure.operation).toBe("openTerminal");
          expect(policy.bridgeFailure(failure)?.reason).toBe("unconfined-execution");
          expect(yield* fs.exists(`${cwd}/setup-marker`)).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(hostLayer));
        expect(nativeSpawn).not.toHaveBeenCalled();
        expect(hostSpawn).not.toHaveBeenCalled();
      }),
  );

  it.effect("refuses ProcessRunner before resolving or spawning a requested executable", () =>
    Effect.gen(function* () {
      hostSpawn.mockClear();
      yield* Effect.gen(function* () {
        const runner = yield* processRunner.make();
        const failure = yield* runner
          .run({ command: "unconfined-provider", args: ["--version"], cwd: "/missing/workspace" })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("ProcessSpawnError");
        expect(policy.bridgeFailure(failure)?.reason).toBe("unconfined-execution");
        if (failure._tag === "ProcessSpawnError") expect(failure.resolvedCommand).toBeUndefined();
      }).pipe(Effect.provide(hostLayer));
      expect(hostSpawn).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    ["hook", ["commit", "--allow-empty", "-m", "bridge"]],
    ["clean-filter", ["add", "payload.txt"]],
    ["smudge-filter", ["checkout", "--", "payload.txt"]],
  ] as const)(
    "refuses Git %s execution before any Git child or repository executable runs",
    ([_path, args]) =>
      Effect.gen(function* () {
        hostSpawn.mockClear();
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bridge-git-" });
          yield* fs.makeDirectory(`${cwd}/.git/hooks`, { recursive: true });
          yield* fs.writeFileString(
            `${cwd}/.git/hooks/pre-commit`,
            "#!/bin/sh\nprintf executed > hook-marker\n",
          );
          yield* fs.chmod(`${cwd}/.git/hooks/pre-commit`, 0o755);
          yield* fs.writeFileString(
            `${cwd}/.git/config`,
            "[core]\n\trepositoryformatversion = 0\n\tbare = false\n[filter \"canary\"]\n\tclean = sh -c 'printf executed > clean-marker; cat'\n\tsmudge = sh -c 'printf executed > smudge-marker; cat'\n\trequired = true\n",
          );
          yield* fs.writeFileString(`${cwd}/.gitattributes`, "payload.txt filter=canary\n");
          yield* fs.writeFileString(`${cwd}/payload.txt`, "workspace payload\n");
          const driver = yield* gitCore.makeGitVcsDriverCore();
          const failure = yield* driver
            .execute({ operation: "bridge.execution.test", cwd, args })
            .pipe(Effect.flip);
          expect(policy.bridgeFailure(failure)?.reason).toBe("unconfined-execution");
          for (const marker of ["hook-marker", "clean-marker", "smudge-marker"])
            expect(yield* fs.exists(`${cwd}/${marker}`)).toBe(false);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            config
              .layerTest(process.cwd(), { prefix: "t3-bridge-git-config-" })
              .pipe(Layer.provideMerge(hostLayer)),
          ),
        );
        expect(hostSpawn).not.toHaveBeenCalled();
      }),
  );

  it.effect.each(["capture", "restore", "diff", "delete"] as const)(
    "refuses checkpoint %s through VcsProcess and ProcessRunner",
    (operation) =>
      Effect.gen(function* () {
        hostSpawn.mockClear();
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bridge-checkpoint-" });
          const runner = yield* processRunner.make();
          const process = yield* vcsProcess.make.pipe(
            Effect.provideService(processRunner.ProcessRunner, runner),
          );
          const driver = yield* git
            .makeVcsDriverShape()
            .pipe(Effect.provideService(vcsProcess.VcsProcess, process));
          const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/bridge-test");
          const checkpoints = driver.checkpoints;
          if (!checkpoints) return yield* Effect.die("Git checkpoint operations are missing");
          const attempt =
            operation === "capture"
              ? checkpoints.captureCheckpoint({ cwd, checkpointRef })
              : operation === "restore"
                ? checkpoints.restoreCheckpoint({ cwd, checkpointRef }).pipe(Effect.asVoid)
                : operation === "diff"
                  ? checkpoints
                      .diffCheckpoints({
                        cwd,
                        fromCheckpointRef: checkpointRef,
                        toCheckpointRef: checkpointRef,
                        ignoreWhitespace: false,
                      })
                      .pipe(Effect.asVoid)
                  : checkpoints.deleteCheckpointRefs({ cwd, checkpointRefs: [checkpointRef] });
          const failure = yield* attempt.pipe(Effect.flip);
          expect(failure._tag).toBe("VcsProcessSpawnError");
          expect(policy.bridgeFailure(failure)?.reason).toBe("unconfined-execution");
          expect(yield* fs.readDirectory(cwd)).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(hostLayer));
        expect(hostSpawn).not.toHaveBeenCalled();
      }),
  );

  it.effect.each(["claudeAgent", "cursor", "grok", "opencode", "antigravity"])(
    "exposes %s as unavailable without constructing its provider runtime",
    (kind) =>
      Effect.gen(function* () {
        const create = vi.fn(() => Effect.die("Unsupported provider factory invoked"));
        const driver = {
          driverKind: ProviderDriverKind.make(kind),
          metadata: { displayName: kind },
          configSchema: Schema.Unknown,
          defaultConfig: () => ({}),
          create,
        } satisfies ProviderDriver<unknown>;
        yield* Effect.gen(function* () {
          const instanceId = ProviderInstanceId.make(`${kind}-bridge`);
          const { registry, mutator } = yield* providers.makeProviderInstanceRegistry({
            drivers: [driver],
            configMap: {
              [instanceId]: {
                driver: driver.driverKind,
                config: { enabled: true },
                displayName: "Configured provider",
              },
            },
          });
          expect(yield* registry.getInstance(instanceId)).toBeUndefined();
          expect(yield* registry.listInstances).toEqual([]);
          const unavailable = yield* registry.listUnavailable;
          expect(unavailable).toHaveLength(1);
          expect(unavailable[0]).toMatchObject({
            instanceId,
            driver: driver.driverKind,
            availability: "unavailable",
            unavailableReason: "Bridge isolation is unavailable: unsupported-provider.",
          });
          yield* mutator.reconcile({});
          expect(yield* registry.listUnavailable).toEqual([]);
        }).pipe(Effect.scoped);
        expect(create).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "preserves ordinary ProcessRunner execution when no bridge profile is requested at startup",
    () =>
      Effect.gen(function* () {
        vi.resetModules();
        vi.stubEnv("T3CODE_BRIDGE_PROFILE", undefined);
        const ordinaryRunner = yield* Effect.promise(() => import("../processRunner.ts"));
        vi.unstubAllEnvs();
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ordinary-process-" });
          const runner = yield* ordinaryRunner.make();
          const result = yield* runner.run({
            command: process.execPath,
            args: [
              "-e",
              "require('node:fs').writeFileSync('marker', 'executed'); process.stdout.write('ordinary')",
            ],
            cwd,
          });
          expect(result.code).toBe(0);
          expect(result.stdout).toBe("ordinary");
          expect(yield* fs.readFileString(`${cwd}/marker`)).toBe("executed");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
      }),
  );
});
