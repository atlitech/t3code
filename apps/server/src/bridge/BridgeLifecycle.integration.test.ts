// @effect-diagnostics nodeBuiltinImport:off -- Real lifecycle tests own temporary native resources.
// @effect-diagnostics globalTimers:off -- Native handshake timers only fail deadlocks; success depends on socket events.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeReadline from "node:readline";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";
import {
  BridgeRuntime,
  acquireWorkspaceLease,
  layer,
  verifyNamespacePrerequisites,
} from "./BridgeRuntime.ts";
import type { BridgeProfile } from "./BridgeTopology.ts";
import { BridgeIsolationUnavailable } from "./BridgePolicy.ts";
import { buildNamespaceCommand, namespaceHelperSource } from "./BridgeNamespace.ts";
import { openProviderEgress } from "./BridgeEgress.ts";

// Independent native processes and explicitly controlled session scopes must survive
// separate Promise/event phases; this runner is confined to that OS harness.
const runNative = <A, E>(effect: Effect.Effect<A, E>) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Native OS ownership harness needs independent scopes across Promise events.
  Effect.runPromise(effect);

const executor = String.raw`#!/runtime/usr/bin/node
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const workspace = process.cwd();
const mode = process.argv[2];
if (mode === '--version') { console.log('codex-cli 0.162.0'); process.exit(0); }
if (mode === 'login' || mode === 'logout') {
  const args = process.argv.slice(2);
  if (!args.includes('cli_auth_credentials_store="file"')) process.exit(125);
  const auth = process.env.CODEX_HOME + '/auth.json';
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  if (args.includes('--device-auth')) {
    if (fs.existsSync(workspace + '/block-auth')) {
      net.createServer(() => {}).listen(workspace + '/login.sock', () => console.log(JSON.stringify({ loginPending: true })));
      return;
    }
    fs.writeFileSync(auth, JSON.stringify({ syntheticPrivateCredential: true }), { mode: 0o600 });
  }
  if (mode === 'logout') fs.rmSync(auth, { force: true });
  const authenticated = fs.existsSync(auth);
  console.log(JSON.stringify({ authenticated, args, proxy: process.env.HTTPS_PROXY }));
  process.exit(args.includes('status') && !authenticated ? 1 : 0);
}
if (fs.existsSync(workspace + '/fail-start')) process.exit(127);
const marker = fs.readFileSync(workspace + '/identity', 'utf8');
const serve = (name, ready) => net.createServer(socket => {
  socket.on('error', () => {});
  socket.once('data', data => {
    if (data.toString() === 'exit') socket.end(marker, () => process.exit(0));
    else if (data.toString() === 'hold') socket.write(marker);
    else socket.end(marker);
  });
}).listen(workspace + '/' + name + '.sock', ready);
const run = () => { if (mode === 'grandchild') {
  serve(mode, () => { process.send({ ready: mode, pid: process.pid }); process.disconnect(); });
} else {
  const child = spawn(process.execPath, [__filename, mode === 'daemon' ? 'grandchild' : 'daemon'], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env,
  });
  child.once('error', () => process.exit(126));
  child.once('message', message => {
    child.unref();
    serve(mode === 'daemon' ? 'daemon' : 'main', () => {
      fs.writeFileSync(process.env.HOME + '/identity', marker);
      if (mode === 'daemon') { process.send({ ready: mode, pid: process.pid, grandchild: message.pid }); process.disconnect(); }
      else console.log(JSON.stringify({ ready: marker, authenticated: fs.existsSync(process.env.CODEX_HOME + '/auth.json'), pid: process.pid, daemon: message.pid, grandchild: message.grandchild }));
    });
  });
} };
if (fs.existsSync(workspace + '/block-start')) {
  const barrier = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => { socket.end(); barrier.close(run); });
  }).listen(workspace + '/startup.sock', () => console.log(JSON.stringify({ startupBlocked: marker })));
} else run();
`;

const custodySource = String.raw`
#define _GNU_SOURCE
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 3) return 125;
  if (!strcmp(argv[1], "wait")) {
    int descriptor = syscall(SYS_pidfd_open, (pid_t)strtol(argv[2], NULL, 10), 0);
    if (descriptor < 0) return 125;
    printf("{\"waiting\":%s}\n", argv[2]); fflush(stdout);
    struct pollfd event = { descriptor, POLLIN, 0 };
    if (poll(&event, 1, -1) != 1 || !(event.revents & POLLIN)) return 125;
    close(descriptor); return 0;
  }
  pid_t child = fork();
  if (child < 0) return 125;
  if (child == 0) { execv(argv[2], &argv[2]); _exit(125); }
  close(3);
  printf("{\"supervisor\":%ld}\n", (long)child); fflush(stdout);
  for (;;) pause();
}
`;

function rawProcess(executable: string, args: ReadonlyArray<string>) {
  const child = NodeChildProcess.spawn(executable, args, {
    env: {},
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const exited = NodeEvents.EventEmitter.once(child, "exit");
  const closed = NodeEvents.EventEmitter.once(child, "close");
  let stderr = "";
  let receipt = "";
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdio[3]!.on("data", (chunk) => {
    receipt += String(chunk);
  });
  const lines = NodeReadline.createInterface({ input: child.stdout! });
  const queue: string[] = [];
  let waiter: ((line: string) => void) | undefined;
  lines.on("line", (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(line);
    } else queue.push(line);
  });
  const next = () =>
    Promise.race([
      new Promise<Record<string, unknown>>((resolve) => {
        const line = queue.shift();
        if (line !== undefined) resolve(JSON.parse(line) as Record<string, unknown>);
        else waiter = (value) => resolve(JSON.parse(value) as Record<string, unknown>);
      }),
      exited.then(() => {
        throw new Error(`owned native process exited before handshake: ${stderr}`);
      }),
    ]);
  return {
    child,
    exited,
    closed,
    next,
    stderr: () => stderr,
    receipt: () => receipt,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(executable.endsWith("custody") ? "SIGKILL" : "SIGTERM");
      await exited;
      lines.close();
    },
  };
}

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-life-"));
  await runNative(Effect.logInfo(`Owned native fixture: ${root}`));
  try {
    const runtimeRoot = NodePath.join(root, "image");
    await NodeFSP.mkdir(NodePath.join(runtimeRoot, "usr/bin"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(runtimeRoot, "etc"));
    await NodeFSP.copyFile(process.execPath, NodePath.join(runtimeRoot, "usr/bin/node"));
    const libraries =
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Native namespace/compiler proof must inspect the actual host, not an injected simulation.
      process.platform === "linux"
        ? NodeChildProcess.execFileSync("ldd", [process.execPath], { encoding: "utf8" })
            .split("\n")
            .flatMap((line) => line.match(/(?:=>\s*)?(\/[^\s]+)\s+\(/)?.[1] ?? [])
        : [];
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Native namespace/compiler proof must inspect the actual host, not an injected simulation.
    if (process.platform === "linux") expect(libraries.length).toBeGreaterThan(0);
    for (const file of libraries) {
      const destination = NodePath.join(runtimeRoot, file);
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      await NodeFSP.copyFile(file, destination);
    }
    await NodeFSP.writeFile(NodePath.join(runtimeRoot, "usr/bin/codex"), executor, { mode: 0o755 });
    const workspaceRoot = NodePath.join(root, "workspaces");
    const stateRoot = NodePath.join(root, "state");
    const supervisorPath = NodePath.join(root, "supervisor");
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Native namespace/compiler proof must inspect the actual host, not an injected simulation.
    if (process.platform === "linux")
      NodeChildProcess.execFileSync("cc", [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        NodeURL.fileURLToPath(new URL("../../bridge-tools/bridge-supervisor.c", import.meta.url)),
        "-o",
        supervisorPath,
      ]);
    await NodeFSP.mkdir(workspaceRoot);
    await NodeFSP.mkdir(stateRoot, { mode: 0o700 });
    for (const name of ["a", "b"]) {
      await NodeFSP.mkdir(NodePath.join(workspaceRoot, name));
      await NodeFSP.writeFile(NodePath.join(workspaceRoot, name, "identity"), name);
    }
    // Directly exercise the boundary service. This fixture does not claim the
    // interactive test host meets the separate dedicated-service admission.
    const profile: BridgeProfile = {
      custodyUid: process.getuid?.() ?? 0,
      custodyGid: process.getgid?.() ?? 0,
      exclusiveCustodyUid: true,
      serviceUnit: NodePath.join(root, "fixture.service"),
      cgroup: "/fixture",
      installedRoot: root,
      runtimeRoot,
      workspaceRoot,
      stateRoot,
      bwrapPath: "/usr/bin/bwrap",
      supervisorPath,
      codexPath: "/runtime/usr/bin/codex",
    };
    return { root, profile, workspace: (name: string) => NodePath.join(workspaceRoot, name) };
  } catch (error) {
    await NodeFSP.rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Independent trusted no-op: failures in the runtime/supervisor under test are not prerequisites. */
function unavailableNativeHost(bwrapPath: string) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Only an actual native kernel probe can justify skipping OS proof.
  if (process.platform !== "linux") return "unsupported-platform" as const;
  try {
    NodeChildProcess.execFileSync(
      bwrapPath,
      [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup",
        "--die-with-parent",
        "--clearenv",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--",
        process.execPath,
        "-e",
        "",
      ],
      { env: {}, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return undefined;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return "missing-bwrap" as const;
    const stderr =
      error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    if (
      /^bwrap: [^\n]*(?:namespace[^\n]*(?:Operation not permitted|Permission denied)|No permissions to create (?:a )?new namespace)[^\n]*$/m.test(
        stderr,
      )
    )
      return "namespace-permission" as const;
    // Unsupported arguments, broken executables, timeouts and arbitrary failures are test failures.
    throw error;
  }
}

async function nativePrerequisites(
  profile: BridgeProfile,
  requireNative = process.env.T3_BRIDGE_REQUIRE_NATIVE === "1",
) {
  const unavailable = unavailableNativeHost(profile.bwrapPath);
  const failure = await runNative(
    verifyNamespacePrerequisites(profile).pipe(
      Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
    ),
  );
  if (unavailable === undefined) {
    if (failure) throw failure;
    return true;
  }
  expect(failure).toBeInstanceOf(BridgeIsolationUnavailable);
  if (!failure) throw new Error("The runtime admitted a host without native prerequisites.");
  expect(failure.reason).toBe(
    unavailable === "unsupported-platform" ? "unsupported-platform" : "runtime-failed",
  );
  await runNative(
    Effect.logInfo(
      `Native confinement unavailable (${unavailable}); production refused with ${failure.reason}`,
    ),
  );
  if (requireNative) throw failure;
  return false;
}

const closeScope = (scope: Scope.Closeable) => runNative(Scope.close(scope, Exit.void));

async function service(profile: BridgeProfile, scope: Scope.Closeable) {
  const context = await runNative(Layer.buildWithScope(layer(profile), scope));
  return Context.get(context, BridgeRuntime);
}

async function start(
  runtime: typeof BridgeRuntime.Service,
  workspace: string,
  name: string,
  scope: Scope.Closeable,
) {
  const handle = await runNative(
    runtime
      .open({ threadId: name, sessionId: name, workspace })
      .pipe(Effect.provideService(Scope.Scope, scope)),
  );
  await NodeFSP.writeFile(
    NodePath.join(workspace, "fixture-owner.json"),
    JSON.stringify({
      token: name,
      parent: process.pid,
      supervisor: Number(handle.pid),
      supervisorStart: await NodeFSP.readFile(`/proc/${Number(handle.pid)}/stat`, "utf8"),
      exitSocket: NodePath.join(workspace, "main.sock"),
      exitMessage: "exit",
    }),
    { mode: 0o600 },
  );
  const output = await runNative(
    handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runHead,
      Effect.timeout("10 seconds"),
    ),
  );
  if (Option.isNone(output)) {
    const code = await runNative(handle.exitCode);
    throw new Error(`native executor exited before readiness (${code})`);
  }
  const ready: unknown = JSON.parse(output.value);
  expect(ready).toMatchObject({ ready: name });
  await NodeFSP.writeFile(
    NodePath.join(workspace, "fixture-descendants.json"),
    JSON.stringify(await descendants(Number(handle.pid))),
    { mode: 0o600 },
  );
  return handle;
}

async function talk(workspace: string, name = "main", message = "ping") {
  return new Promise<string>((resolve, reject) => {
    const socket = NodeNet.connect(NodePath.join(workspace, `${name}.sock`));
    const guard = setTimeout(() => {
      socket.destroy();
      reject(new Error("native fixture handshake timed out"));
    }, 2000);
    let response = "";
    socket.once("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
    socket.once("connect", () => socket.write(message));
    socket.on("data", (chunk) => {
      response += String(chunk);
    });
    socket.once("end", () => {
      clearTimeout(guard);
      resolve(response);
    });
  });
}

async function hold(workspace: string, name: string) {
  const socket = NodeNet.connect(NodePath.join(workspace, `${name}.sock`));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => socket.write("hold"));
    socket.once("data", () => resolve());
  });
  socket.on("error", () => {});
  socket.resume();
  return { closed, close: () => socket.destroy() };
}

async function descendants(
  owner: number,
): Promise<ReadonlyArray<{ pid: number; namespace: string }>> {
  const children = (await NodeFSP.readFile(`/proc/${owner}/task/${owner}/children`, "utf8"))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  const nested = await Promise.all(
    children.map(async (pid) => [
      { pid, namespace: await NodeFSP.readlink(`/proc/${pid}/ns/pid`) },
      ...(await descendants(pid)),
    ]),
  );
  return nested.flat();
}

async function expectGone(recorded: ReadonlyArray<{ pid: number; namespace: string }>) {
  const retained: string[] = [];
  for (const { pid, namespace } of recorded) {
    // Zombies have no namespace link; a recycled host PID is harmless only if
    // its namespace differs. No test ever signals a discovered descendant.
    const current = await NodeFSP.readlink(`/proc/${pid}/ns/pid`).catch(() => undefined);
    const status =
      current === namespace
        ? await NodeFSP.readFile(`/proc/${pid}/status`, "utf8").catch(() => "gone")
        : "gone";
    const details = status
      .split("\n")
      .filter((line) => /^(State|PPid|NSpid|Name):/.test(line))
      .join("; ");
    if (current === namespace && !/^State:\s+Z/m.test(status) && status !== "gone")
      retained.push(`${pid} ${namespace}: ${details}`);
  }
  expect(retained, "live recorded processes retained their namespace after lease release").toEqual(
    [],
  );
}

describe("real BridgeRuntime ownership and lifecycle", () => {
  it("provisions, consumes and removes credentials only in the selected thread's private home", async () => {
    const f = await fixture();
    const rootScope = Scope.makeUnsafe();
    const scopes: Scope.Closeable[] = [];
    try {
      if (!(await nativePrerequisites(f.profile))) return;
      const runtime = await service(f.profile, rootScope);
      const auth = async (
        purpose: "device-login" | "login-status" | "logout",
        threadId: string,
        workspace = f.workspace(threadId),
      ) => {
        const scope = Scope.makeUnsafe();
        scopes.push(scope);
        const handle = await runNative(
          runtime
            .open({ threadId, sessionId: `auth:${purpose}:${threadId}`, workspace, purpose })
            .pipe(Effect.provideService(Scope.Scope, scope)),
        );
        const [output, code] = await runNative(
          Effect.all(
            [
              handle.stdout.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (all, chunk) => all + chunk,
                ),
              ),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          ),
        );
        await closeScope(scope);
        return { result: JSON.parse(output), code };
      };
      const login = await auth("device-login", "a");
      expect(login).toMatchObject({
        code: 0,
        result: {
          authenticated: true,
          proxy: "http://127.0.0.1:18080",
          args: ["login", "--device-auth", "-c", 'cli_auth_credentials_store="file"'],
        },
      });
      expect(await auth("login-status", "a")).toMatchObject({
        code: 0,
        result: { authenticated: true },
      });
      expect(await auth("login-status", "b")).toMatchObject({
        code: 1,
        result: { authenticated: false },
      });
      const aScope = Scope.makeUnsafe();
      scopes.push(aScope);
      const a = await runNative(
        runtime
          .open({ threadId: "a", sessionId: "app-a", workspace: f.workspace("a") })
          .pipe(Effect.provideService(Scope.Scope, aScope)),
      );
      const aReady = await runNative(
        a.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
      );
      expect(Option.isSome(aReady) && JSON.parse(aReady.value)).toMatchObject({
        authenticated: true,
      });
      const bScope = Scope.makeUnsafe();
      scopes.push(bScope);
      const b = await runNative(
        runtime
          .open({ threadId: "b", sessionId: "app-b", workspace: f.workspace("b") })
          .pipe(Effect.provideService(Scope.Scope, bScope)),
      );
      const bReady = await runNative(
        b.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
      );
      expect(Option.isSome(bReady) && JSON.parse(bReady.value)).toMatchObject({
        authenticated: false,
      });
      const busyScope = Scope.makeUnsafe();
      scopes.push(busyScope);
      expect(
        await runNative(
          runtime
            .open({
              threadId: "a",
              sessionId: "busy-login",
              workspace: f.workspace("b"),
              purpose: "device-login",
            })
            .pipe(Effect.provideService(Scope.Scope, busyScope), Effect.flip),
        ),
      ).toMatchObject({ reason: "workspace-busy" });
      await closeScope(aScope);
      await closeScope(bScope);
      expect(await auth("logout", "a")).toMatchObject({
        code: 0,
        result: {
          authenticated: false,
          args: ["logout", "-c", 'cli_auth_credentials_store="file"'],
        },
      });
      expect(await auth("login-status", "a")).toMatchObject({
        code: 1,
        result: { authenticated: false },
      });
      await NodeFSP.writeFile(NodePath.join(f.workspace("a"), "block-auth"), "");
      const cancelScope = Scope.makeUnsafe();
      scopes.push(cancelScope);
      const pending = await runNative(
        runtime
          .open({
            threadId: "a",
            sessionId: "pending-login",
            workspace: f.workspace("a"),
            purpose: "device-login",
          })
          .pipe(Effect.provideService(Scope.Scope, cancelScope)),
      );
      const pendingOutput = await runNative(
        pending.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
      );
      expect(Option.isSome(pendingOutput) && JSON.parse(pendingOutput.value)).toMatchObject({
        loginPending: true,
      });
      const tree = await descendants(Number(pending.pid));
      await closeScope(cancelScope);
      await expectGone(tree);
      expect(await auth("login-status", "a")).toMatchObject({
        code: 1,
        result: { authenticated: false },
      });
      expect(await NodeFSP.readdir(NodePath.join(f.profile.stateRoot, "sessions"))).toEqual([]);
    } finally {
      await Promise.all(scopes.map(closeScope));
      await closeScope(rootScope);
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reaps setsid daemons and grandchildren before A releases its workspace, while B stays responsive", async () => {
    const f = await fixture();
    const rootScope = Scope.makeUnsafe();
    const scopes: Scope.Closeable[] = [];
    try {
      if (!(await nativePrerequisites(f.profile))) return;
      const runtime = await service(f.profile, rootScope);
      const aScope = Scope.makeUnsafe();
      scopes.push(aScope);
      const bScope = Scope.makeUnsafe();
      scopes.push(bScope);
      const a = await start(runtime, f.workspace("a"), "a", aScope);
      const b = await start(runtime, f.workspace("b"), "b", bScope);
      const aTree = await descendants(Number(a.pid));
      expect(aTree.length).toBeGreaterThanOrEqual(4);
      for (const name of ["main", "daemon", "grandchild"]) {
        expect(await talk(f.workspace("a"), name)).toBe("a");
        expect(await talk(f.workspace("b"), name)).toBe("b");
      }
      const competing = Scope.makeUnsafe();
      scopes.push(competing);
      const busy = await runNative(
        runtime
          .open({ threadId: "competing", sessionId: "competing", workspace: f.workspace("a") })
          .pipe(Effect.provideService(Scope.Scope, competing), Effect.flip),
      );
      expect(busy).toBeInstanceOf(BridgeIsolationUnavailable);
      expect(busy.reason).toBe("workspace-busy");
      await closeScope(competing);
      await closeScope(aScope);
      await expectGone(aTree);
      for (const name of ["main", "daemon", "grandchild"])
        await expect(talk(f.workspace("a"), name)).rejects.toThrow();
      expect(await talk(f.workspace("b"))).toBe("b");
      expect(await runNative(b.isRunning)).toBe(true);
      // Stale pathname sockets are workspace artifacts, removed only after the
      // owner namespace is gone. They are not custody-managed resources.
      for (const name of ["main", "daemon", "grandchild"])
        await NodeFSP.unlink(NodePath.join(f.workspace("a"), `${name}.sock`));
      const restartedScope = Scope.makeUnsafe();
      scopes.push(restartedScope);
      const restarted = await start(runtime, f.workspace("a"), "a", restartedScope);
      const restartTree = await descendants(Number(restarted.pid));
      expect(await talk(f.workspace("a"))).toBe("a");
      expect(await talk(f.workspace("b"))).toBe("b");
      expect(await talk(f.workspace("a"), "main", "exit")).toBe("a");
      expect(await runNative(restarted.exitCode)).toBe(0);
      await closeScope(restartedScope);
      await expectGone(restartTree);
      expect(await talk(f.workspace("b"), "grandchild")).toBe("b");
      const bTree = await descendants(Number(b.pid));
      await closeScope(bScope);
      await expectGone(bTree);
      expect(await NodeFSP.readdir(NodePath.join(f.profile.stateRoot, "sessions"))).toEqual([]);
    } finally {
      await Promise.all(scopes.map(closeScope));
      await closeScope(rootScope);
      await expect(
        NodeFSP.stat(NodePath.join(f.profile.stateRoot, "custody.lock")),
      ).rejects.toThrow();
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("cleans a failed native start and permits a subsequent successful service start", async () => {
    const f = await fixture();
    const failedRoot = Scope.makeUnsafe();
    const failedSession = Scope.makeUnsafe();
    const goodRoot = Scope.makeUnsafe();
    const goodSession = Scope.makeUnsafe();
    const badExecutorSession = Scope.makeUnsafe();
    try {
      if (!(await nativePrerequisites(f.profile))) return;
      // An independently capable host cannot turn an implementation failure into
      // a passing skip, even when native proof is not required by the environment.
      for (const broken of [
        { ...f.profile, supervisorPath: NodePath.join(f.root, "missing-supervisor") },
        { ...f.profile, codexPath: "/runtime/usr/bin/missing-codex" },
      ]) {
        await expect(nativePrerequisites(broken, false)).rejects.toMatchObject({
          _tag: "BridgeIsolationUnavailable",
          reason: "runtime-failed",
        });
      }
      await expect(
        service({ ...f.profile, bwrapPath: NodePath.join(f.root, "missing-bwrap") }, failedRoot),
      ).rejects.toMatchObject({ _tag: "BridgeIsolationUnavailable", reason: "runtime-failed" });
      await closeScope(failedSession);
      expect(await NodeFSP.readdir(NodePath.join(f.profile.stateRoot, "sessions"))).toEqual([]);
      await closeScope(failedRoot);
      const good = await service(f.profile, goodRoot);
      await NodeFSP.writeFile(
        NodePath.join(f.workspace("a"), "fail-start"),
        "fixture-startup-failure",
      );
      const failed = await runNative(
        good
          .open({ threadId: "a", sessionId: "failed", workspace: f.workspace("a") })
          .pipe(Effect.provideService(Scope.Scope, badExecutorSession)),
      );
      expect(await runNative(failed.exitCode)).toBe(127);
      await closeScope(badExecutorSession);
      expect(await NodeFSP.readdir(NodePath.join(f.profile.stateRoot, "sessions"))).toEqual([]);
      await NodeFSP.unlink(NodePath.join(f.workspace("a"), "fail-start"));
      const child = await start(good, f.workspace("a"), "a", goodSession);
      const recorded = await descendants(Number(child.pid));
      expect(await talk(f.workspace("a"))).toBe("a");
      await closeScope(goodSession);
      await expectGone(recorded);
      expect(await NodeFSP.readdir(NodePath.join(f.profile.stateRoot, "sessions"))).toEqual([]);
    } finally {
      await closeScope(failedSession);
      await closeScope(goodSession);
      await closeScope(badExecutorSession);
      await closeScope(failedRoot);
      await closeScope(goodRoot);
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses aliases, shared Git storage and overlapping workspace leases", async () => {
    const f = await fixture();
    const leases = new Set<string>();
    try {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Native namespace/compiler proof must inspect the actual host, not an injected simulation.
      if (process.platform !== "linux") {
        expect(await nativePrerequisites(f.profile)).toBe(false);
        return;
      }
      const held = await acquireWorkspaceLease(f.profile.workspaceRoot, f.workspace("a"), leases);
      await expect(
        acquireWorkspaceLease(f.profile.workspaceRoot, f.workspace("a"), leases),
      ).rejects.toMatchObject({ reason: "workspace-busy" });
      const nested = NodePath.join(f.workspace("a"), "nested");
      await NodeFSP.mkdir(nested);
      await expect(
        acquireWorkspaceLease(f.profile.workspaceRoot, nested, leases),
      ).rejects.toMatchObject({ reason: "workspace-busy" });
      const independent = await acquireWorkspaceLease(
        f.profile.workspaceRoot,
        f.workspace("b"),
        leases,
      );
      independent.release();
      held.release();
      const alias = f.workspace("alias");
      await NodeFSP.symlink(f.workspace("a"), alias);
      await expect(
        acquireWorkspaceLease(f.profile.workspaceRoot, alias, leases),
      ).rejects.toMatchObject({ reason: "unsupported-workspace" });
      await NodeFSP.writeFile(NodePath.join(f.workspace("a"), ".git"), "gitdir: /outside/shared");
      await expect(
        acquireWorkspaceLease(f.profile.workspaceRoot, f.workspace("a"), leases),
      ).rejects.toMatchObject({ reason: "unsupported-workspace" });
      await NodeFSP.unlink(NodePath.join(f.workspace("a"), ".git"));
      await NodeFSP.mkdir(NodePath.join(f.workspace("a"), ".git/objects/info"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(f.workspace("a"), ".git/objects/info/alternates"),
        "/outside/shared",
      );
      await expect(
        acquireWorkspaceLease(f.profile.workspaceRoot, f.workspace("a"), leases),
      ).rejects.toMatchObject({ reason: "unsupported-workspace" });
      expect(leases.size).toBe(0);
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });

  it("retains a failed supervisor's lease and refuses reuse while its sibling stays responsive", async () => {
    const f = await fixture();
    const rootScope = Scope.makeUnsafe();
    const aScope = Scope.makeUnsafe();
    const bScope = Scope.makeUnsafe();
    const reuseScope = Scope.makeUnsafe();
    const held: Awaited<ReturnType<typeof hold>>[] = [];
    try {
      if (!(await nativePrerequisites(f.profile))) return;
      const runtime = await service(f.profile, rootScope);
      const a = await start(runtime, f.workspace("a"), "a", aScope);
      await start(runtime, f.workspace("b"), "b", bScope);
      held.push(
        ...(await Promise.all(
          ["main", "daemon", "grandchild"].map((name) => hold(f.workspace("a"), name)),
        )),
      );
      // This is the supervisor PID returned by the production spawn we own.
      process.kill(Number(a.pid), "SIGKILL");
      await expect(runNative(a.exitCode)).rejects.toThrow();
      // Kernel EOF proves these recorded executable descendants stopped; the
      // missing supervisor still cannot supply its waitpid/ECHILD proof.
      await closeScope(aScope).catch(() => {});
      const failure = await runNative(
        runtime
          .open({ threadId: "reuse", sessionId: "reuse", workspace: f.workspace("a") })
          .pipe(Effect.provideService(Scope.Scope, reuseScope), Effect.flip),
      );
      expect(failure).toMatchObject({
        _tag: "BridgeIsolationUnavailable",
        reason: "runtime-failed",
      });
      expect(await NodeFSP.readdir(NodePath.join(f.profile.stateRoot, "sessions"))).toHaveLength(2);
      expect(await talk(f.workspace("b"), "grandchild")).toBe("b");
      await closeScope(bScope);
      expect(await NodeFSP.readdir(NodePath.join(f.profile.stateRoot, "sessions"))).toHaveLength(1);
      // This explicit fixture-owned exit channel cleans the synthetic tree
      // after checking poisoned custody; it is not a service teardown proof.
      await talk(f.workspace("a"), "main", "exit").catch(() => {});
      await Promise.all(held.map((socket) => socket.closed));
    } finally {
      for (const socket of held) socket.close();
      await closeScope(aScope).catch(() => {});
      await closeScope(bScope);
      await closeScope(reuseScope);
      await closeScope(rootScope);
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("closes before provider readiness and releases the lease while a sibling keeps working", async () => {
    const f = await fixture();
    const rootScope = Scope.makeUnsafe();
    const scopes: Scope.Closeable[] = [];
    try {
      if (!(await nativePrerequisites(f.profile))) return;
      const runtime = await service(f.profile, rootScope);
      const bScope = Scope.makeUnsafe();
      scopes.push(bScope);
      await start(runtime, f.workspace("b"), "b", bScope);
      await NodeFSP.writeFile(
        NodePath.join(f.workspace("a"), "block-start"),
        "fixture-startup-barrier",
      );
      for (let turn = 0; turn < 3; turn++) {
        const scope = Scope.makeUnsafe();
        scopes.push(scope);
        const handle = await runNative(
          runtime
            .open({ threadId: "a", sessionId: `early-${turn}`, workspace: f.workspace("a") })
            .pipe(Effect.provideService(Scope.Scope, scope)),
        );
        await NodeFSP.writeFile(
          NodePath.join(f.workspace("a"), "fixture-owner.json"),
          JSON.stringify({
            token: `early-${turn}`,
            parent: process.pid,
            supervisor: Number(handle.pid),
            supervisorStart: await NodeFSP.readFile(`/proc/${Number(handle.pid)}/stat`, "utf8"),
            releaseSocket: NodePath.join(f.workspace("a"), "startup.sock"),
          }),
          { mode: 0o600 },
        );
        const blocked = await runNative(
          handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runHead,
            Effect.timeout("10 seconds"),
          ),
        );
        expect(Option.isSome(blocked) ? JSON.parse(blocked.value) : undefined).toEqual({
          startupBlocked: "a",
        });
        const recorded = await descendants(Number(handle.pid));
        expect(recorded.length).toBeGreaterThanOrEqual(3);
        await NodeFSP.writeFile(
          NodePath.join(f.workspace("a"), "fixture-descendants.json"),
          JSON.stringify(recorded),
          { mode: 0o600 },
        );
        await closeScope(scope);
        await expectGone(recorded);
        await NodeFSP.unlink(NodePath.join(f.workspace("a"), "startup.sock"));
        expect(await talk(f.workspace("b"))).toBe("b");
      }
      await closeScope(bScope);
      expect(await NodeFSP.readdir(NodePath.join(f.profile.stateRoot, "sessions"))).toEqual([]);
    } finally {
      await Promise.all(scopes.map(closeScope));
      await closeScope(rootScope);
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reaps after custody-parent death and real bwrap failures before and after its init receipt", async () => {
    const f = await fixture();
    const owned: ReturnType<typeof rawProcess>[] = [];
    let proxy: Awaited<ReturnType<typeof openProviderEgress>> | undefined;
    try {
      if (!(await nativePrerequisites(f.profile))) return;
      const source = NodePath.join(f.root, "custody.c");
      const custodyPath = NodePath.join(f.root, "custody");
      await NodeFSP.writeFile(source, custodySource);
      NodeChildProcess.execFileSync("cc", [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        source,
        "-o",
        custodyPath,
      ]);
      const home = NodePath.join(f.root, "home");
      const helperPath = NodePath.join(f.root, "helper.cjs");
      const proxySocket = NodePath.join(f.root, "egress.sock");
      await NodeFSP.mkdir(home, { mode: 0o700 });
      await NodeFSP.writeFile(helperPath, namespaceHelperSource, { mode: 0o400 });
      proxy = await openProviderEgress(proxySocket);
      await NodeFSP.writeFile(
        NodePath.join(f.workspace("a"), "block-start"),
        "fixture-startup-barrier",
      );
      const command = buildNamespaceCommand({
        bwrapPath: f.profile.bwrapPath,
        runtimeRoot: f.profile.runtimeRoot,
        workspace: f.workspace("a"),
        home,
        proxySocket,
        helperPath,
        executable: f.profile.codexPath,
        args: ["app-server"],
      });
      const custody = rawProcess(custodyPath, [
        "custody",
        f.profile.supervisorPath,
        command.command,
        ...command.args,
      ]);
      owned.push(custody);
      await NodeFSP.writeFile(
        NodePath.join(f.root, "custody-owner.json"),
        JSON.stringify({
          parent: process.pid,
          custody: custody.child.pid,
          token: NodePath.basename(f.root),
          custodyStart: await NodeFSP.readFile(`/proc/${custody.child.pid}/stat`, "utf8"),
        }),
        { mode: 0o600 },
      );
      const receipt = await custody.next();
      if (typeof receipt.supervisor !== "number")
        throw new Error("missing owned supervisor receipt");
      await NodeFSP.writeFile(
        NodePath.join(f.root, "custody-supervisor.json"),
        JSON.stringify({
          supervisor: receipt.supervisor,
          start: await NodeFSP.readFile(`/proc/${receipt.supervisor}/stat`, "utf8"),
        }),
        { mode: 0o600 },
      );
      expect(await custody.next()).toEqual({ startupBlocked: "a" });
      const recorded = await descendants(receipt.supervisor);
      expect(recorded.length).toBeGreaterThanOrEqual(3);
      await NodeFSP.writeFile(
        NodePath.join(f.root, "custody-descendants.json"),
        JSON.stringify(recorded),
        {
          mode: 0o600,
        },
      );
      const waiter = rawProcess(custodyPath, ["wait", String(receipt.supervisor)]);
      owned.push(waiter);
      expect(await waiter.next()).toEqual({ waiting: receipt.supervisor });
      // Kill the custody process captured by this spawn, then await the kernel
      // pidfd event for its recorded supervisor, rather than inspecting names.
      custody.child.kill("SIGKILL");
      expect(await waiter.exited).toEqual([0, null]);
      await expectGone(recorded);
      expect(await custody.exited).toEqual([null, "SIGKILL"]);

      const invalid = buildNamespaceCommand({
        bwrapPath: f.profile.bwrapPath,
        runtimeRoot: f.profile.runtimeRoot,
        workspace: f.workspace("a"),
        home,
        proxySocket,
        helperPath: NodePath.join(f.root, "missing-helper"),
        executable: f.profile.codexPath,
        args: ["app-server"],
      });
      const failed = rawProcess(f.profile.supervisorPath, [invalid.command, ...invalid.args]);
      owned.push(failed);
      await NodeFSP.writeFile(
        NodePath.join(f.root, "failed-owner.json"),
        JSON.stringify({
          parent: process.pid,
          supervisor: failed.child.pid,
          token: "pre-info-mount-failure",
        }),
        { mode: 0o600 },
      );
      const [code, signal] = await failed.closed;
      expect(code).not.toBe(0);
      expect(signal).toBe(null);
      expect(failed.receipt()).toBe("R");
      expect(failed.stderr()).toContain("missing-helper");
      const preInfo = rawProcess(f.profile.supervisorPath, [
        f.profile.bwrapPath,
        "--invalid-native-fixture-option",
      ]);
      owned.push(preInfo);
      await NodeFSP.writeFile(
        NodePath.join(f.root, "pre-info-owner.json"),
        JSON.stringify({
          parent: process.pid,
          supervisor: preInfo.child.pid,
          token: "pre-info-parse-failure",
        }),
        { mode: 0o600 },
      );
      expect(await preInfo.closed).toEqual([125, null]);
      expect(preInfo.receipt()).toBe("");
      expect(preInfo.stderr()).toContain("invalid-native-fixture-option");
    } finally {
      await Promise.all(owned.map((process) => process.stop()));
      await proxy?.close();
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  }, 30_000);
});
