// @effect-diagnostics nodeBuiltinImport:off -- This service owns native namespace resources and leases.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { spawnNamespaceProcess } from "./BridgeNamespaceProcess.ts";
import { ChildProcessSpawner } from "effect/process";
import { BridgeIsolationUnavailable } from "./BridgePolicy.ts";
import type { BridgeProfile } from "./BridgeTopology.ts";
import { buildNamespaceCommand, namespaceHelperSource } from "./BridgeNamespace.ts";
import { openProviderEgress } from "./BridgeEgress.ts";

export class BridgeRuntime extends Context.Service<
  BridgeRuntime,
  {
    readonly open: (input: {
      readonly threadId: string;
      readonly sessionId: string;
      readonly workspace: string;
    }) => Effect.Effect<
      ChildProcessSpawner.ChildProcessHandle,
      BridgeIsolationUnavailable,
      Scope.Scope
    >;
  }
>()("t3/bridge/BridgeRuntime") {}

const isIsolationUnavailable = Schema.is(BridgeIsolationUnavailable);
const runtimeFailure = (cause: unknown) =>
  isIsolationUnavailable(cause)
    ? cause
    : new BridgeIsolationUnavailable({ reason: "runtime-failed", cause });

/** Proves the installed primitive and trusted runtime work; topology admission remains separate. */
export const verifyNamespacePrerequisites = (profile: BridgeProfile) =>
  Effect.scoped(
    Effect.gen(function* () {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Admission must verify the real kernel platform, never an injectable claim.
      if (process.platform !== "linux")
        return yield* new BridgeIsolationUnavailable({ reason: "unsupported-platform" });
      const fixture = yield* Effect.acquireRelease(
        awaitable(async () => {
          const workspace = await NodeFSP.mkdtemp(
            NodePath.join(profile.workspaceRoot, "readiness-"),
          );
          let control: string | undefined;
          try {
            control = await NodeFSP.mkdtemp(NodePath.join(profile.stateRoot, "readiness-"));
            const home = NodePath.join(control, "home");
            await NodeFSP.mkdir(home, { mode: 0o700 });
            const helperPath = NodePath.join(control, "helper.cjs");
            await NodeFSP.writeFile(helperPath, namespaceHelperSource, { mode: 0o400 });
            return {
              workspace,
              control,
              home,
              helperPath,
              proxySocket: NodePath.join(control, "egress.sock"),
            };
          } catch (cause) {
            await NodeFSP.rm(workspace, { recursive: true, force: true });
            if (control) await NodeFSP.rm(control, { recursive: true, force: true });
            throw cause;
          }
        }),
        (fixture) =>
          awaitable(async () => {
            await NodeFSP.rm(fixture.workspace, { recursive: true, force: true });
            await NodeFSP.rm(fixture.control, { recursive: true, force: true });
          }).pipe(Effect.orDie),
      );
      yield* Effect.acquireRelease(
        awaitable(() => openProviderEgress(fixture.proxySocket)),
        (proxy) => awaitable(proxy.close).pipe(Effect.orDie),
      );
      const namespaces = ["user", "pid", "mnt", "net", "ipc", "uts", "cgroup"];
      const host = yield* awaitable(() =>
        Promise.all(namespaces.map((name) => NodeFSP.readlink(`/proc/self/ns/${name}`))),
      );
      const source =
        `const fs=require('node:fs');const cp=require('node:child_process');` +
        `const names=['user','pid','mnt','net','ipc','uts','cgroup'];` +
        `process.stdout.write(names.map(n=>fs.readlinkSync('/proc/self/ns/'+n)).join('\\n')+'\\n');` +
        `process.stdout.write(cp.execFileSync(process.argv[1],['--version'],{encoding:'utf8'}));`;
      const child = yield* spawnNamespaceProcess(
        profile.supervisorPath,
        buildNamespaceCommand({
          ...fixture,
          bwrapPath: profile.bwrapPath,
          runtimeRoot: profile.runtimeRoot,
          executable: "/runtime/usr/bin/node",
          args: ["-e", source, profile.codexPath],
        }),
      ).pipe(Effect.mapError(runtimeFailure));
      const [stdout, code] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (out, next) => out + next,
            ),
          ),
          child.exitCode,
          child.stderr.pipe(Stream.runDrain),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(runtimeFailure),
        Effect.timeout("15 seconds"),
        Effect.mapError(runtimeFailure),
      );
      const lines = stdout.trim().split("\n");
      if (
        code !== 0 ||
        lines.length !== namespaces.length + 1 ||
        lines.slice(0, -1).some((value, index) => value === host[index]) ||
        lines.at(-1) !== "codex-cli 0.162.0"
      )
        return yield* new BridgeIsolationUnavailable({ reason: "runtime-failed" });
    }),
  );

/** A service owns a single canonical workspace root exclusively until teardown completes. */
export async function acquireWorkspaceLease(root: string, workspace: string, leases: Set<string>) {
  if (
    !NodePath.isAbsolute(workspace) ||
    NodePath.normalize(workspace) !== workspace ||
    !workspace.startsWith(`${root}/`) ||
    (await NodeFSP.realpath(workspace)) !== workspace
  ) {
    throw new BridgeIsolationUnavailable({ reason: "unsupported-workspace" });
  }
  const stat = await NodeFSP.lstat(workspace);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.())
    throw new BridgeIsolationUnavailable({ reason: "unsupported-workspace" });
  const git = await NodeFSP.lstat(NodePath.join(workspace, ".git")).catch(() => undefined);
  if (git && !git.isDirectory())
    throw new BridgeIsolationUnavailable({ reason: "unsupported-workspace" });
  if (
    git &&
    (await NodeFSP.readdir(NodePath.join(workspace, ".git"))).some((name) =>
      ["commondir", "worktrees", "modules", "objects/info/alternates"].includes(name),
    )
  ) {
    throw new BridgeIsolationUnavailable({ reason: "unsupported-workspace" });
  }
  if (
    git &&
    (await NodeFSP.stat(NodePath.join(workspace, ".git/objects/info/alternates")).then(
      () => true,
      () => false,
    ))
  ) {
    throw new BridgeIsolationUnavailable({ reason: "unsupported-workspace" });
  }
  if (
    [...leases].some(
      (held) =>
        held === workspace || held.startsWith(`${workspace}/`) || workspace.startsWith(`${held}/`),
    )
  ) {
    throw new BridgeIsolationUnavailable({ reason: "workspace-busy" });
  }
  leases.add(workspace);
  return {
    release: () => {
      leases.delete(workspace);
    },
  };
}

const make = (profile: BridgeProfile) =>
  Effect.gen(function* () {
    // This service alone owns the trusted supervisor and namespace resources.
    let poisoned = false;
    const leases = new Set<string>();
    const homes = new Set<string>();
    const bootId = awaitable(() => NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8"));
    const boot = yield* bootId;
    const custodyLock = NodePath.join(profile.stateRoot, "custody.lock");
    yield* Effect.acquireRelease(
      awaitable(async () => {
        const previous = await NodeFSP.readFile(custodyLock, "utf8").catch(() => undefined);
        if (previous) {
          const record: unknown = JSON.parse(previous);
          if (!record || typeof record !== "object" || !("pid" in record) || !("boot" in record))
            throw new BridgeIsolationUnavailable({ reason: "unsupported-topology" });
          if (
            record.boot === boot &&
            (await NodeFSP.stat(`/proc/${String(record.pid)}`).then(
              () => true,
              () => false,
            ))
          )
            throw new BridgeIsolationUnavailable({ reason: "workspace-busy" });
          await NodeFSP.unlink(custodyLock);
        }
        const handle = await NodeFSP.open(custodyLock, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, boot }));
          await handle.close();
          // Admission has already refused any other process under the exclusive UID.
          // Sweep only control directories recorded by a previous, absent owner.
          const sessions = NodePath.join(profile.stateRoot, "sessions");
          await NodeFSP.mkdir(sessions, { mode: 0o700, recursive: true });
          for (const entry of await NodeFSP.readdir(sessions, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^run-[a-zA-Z0-9]+$/.test(entry.name)) continue;
            const directory = NodePath.join(sessions, entry.name);
            const owner: unknown = JSON.parse(
              await NodeFSP.readFile(NodePath.join(directory, "owner.json"), "utf8"),
            );
            if (
              !owner ||
              typeof owner !== "object" ||
              !("pid" in owner) ||
              !("boot" in owner) ||
              (owner.boot === boot &&
                (await NodeFSP.stat(`/proc/${String(owner.pid)}`).then(
                  () => true,
                  () => false,
                )))
            ) {
              throw new BridgeIsolationUnavailable({ reason: "unsupported-topology" });
            }
            await NodeFSP.rm(directory, { recursive: true });
          }
          await NodeFSP.mkdir(NodePath.join(profile.stateRoot, "homes"), {
            mode: 0o700,
            recursive: true,
          });
        } catch (cause) {
          await handle.close().catch(() => {});
          await NodeFSP.unlink(custodyLock);
          throw cause;
        }
      }),
      () => awaitable(() => NodeFSP.unlink(custodyLock)).pipe(Effect.orDie),
    );
    yield* verifyNamespacePrerequisites(profile);
    return BridgeRuntime.of({
      open: (input) =>
        Effect.gen(function* () {
          if (poisoned) return yield* new BridgeIsolationUnavailable({ reason: "runtime-failed" });
          let teardownProven = true;
          yield* Effect.acquireRelease(
            awaitable(() => acquireWorkspaceLease(profile.workspaceRoot, input.workspace, leases)),
            (lease) =>
              Effect.sync(() => {
                if (teardownProven) lease.release();
              }),
          );
          const key = NodeCrypto.createHash("sha256").update(input.threadId).digest("hex");
          const home = NodePath.join(profile.stateRoot, "homes", key);
          yield* Effect.acquireRelease(
            Effect.suspend(() => {
              if (homes.has(home))
                return Effect.fail(new BridgeIsolationUnavailable({ reason: "workspace-busy" }));
              homes.add(home);
              return Effect.succeed(home);
            }),
            (home) =>
              Effect.sync(() => {
                if (teardownProven) homes.delete(home);
              }),
          );
          yield* awaitable(async () => {
            await NodeFSP.mkdir(home, { mode: 0o700, recursive: true });
            const homeStat = await NodeFSP.lstat(home);
            if (
              !homeStat.isDirectory() ||
              homeStat.isSymbolicLink() ||
              homeStat.uid !== profile.custodyUid ||
              (homeStat.mode & 0o077) !== 0
            )
              throw new BridgeIsolationUnavailable({ reason: "unsupported-topology" });
          });
          const control = yield* Effect.acquireRelease(
            awaitable(async () => {
              const directory = await NodeFSP.mkdtemp(
                NodePath.join(profile.stateRoot, "sessions", "run-"),
              );
              try {
                await NodeFSP.chmod(directory, 0o700);
                await NodeFSP.writeFile(
                  NodePath.join(directory, "owner.json"),
                  JSON.stringify({ pid: process.pid, boot }),
                  { mode: 0o600, flag: "wx" },
                );
                const helperPath = NodePath.join(directory, "helper.cjs");
                await NodeFSP.writeFile(helperPath, namespaceHelperSource, {
                  mode: 0o400,
                  flag: "wx",
                });
                return {
                  directory,
                  helperPath,
                  proxySocket: NodePath.join(directory, "egress.sock"),
                };
              } catch (cause) {
                await NodeFSP.rm(directory, { recursive: true, force: true });
                throw cause;
              }
            }),
            (control) =>
              teardownProven
                ? awaitable(() =>
                    NodeFSP.rm(control.directory, { recursive: true, force: true }),
                  ).pipe(Effect.orDie)
                : Effect.void,
          );
          yield* Effect.acquireRelease(
            awaitable(() => openProviderEgress(control.proxySocket)),
            (proxy) => awaitable(proxy.close).pipe(Effect.orDie),
          );
          const handle = yield* spawnNamespaceProcess(
            profile.supervisorPath,
            buildNamespaceCommand({
              ...control,
              bwrapPath: profile.bwrapPath,
              runtimeRoot: profile.runtimeRoot,
              workspace: input.workspace,
              home,
              executable: profile.codexPath,
              args: [
                "app-server",
                "-c",
                "model_providers.openai.supports_websockets=false",
                "-c",
                "features.responses_websockets=false",
                "-c",
                "features.responses_websockets_v2=false",
                "-c",
                'cli_auth_credentials_store="file"',
              ],
            }),
            () => {
              teardownProven = false;
              poisoned = true;
            },
          ).pipe(Effect.mapError(runtimeFailure));
          return handle;
        }),
    });
  });

const awaitable = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: runtimeFailure });

export const layer = (profile: BridgeProfile) => Layer.effect(BridgeRuntime, make(profile));
