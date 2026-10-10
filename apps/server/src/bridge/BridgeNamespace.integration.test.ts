// @effect-diagnostics nodeBuiltinImport:off -- Native adversarial probes own temporary OS resources.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { buildNamespaceCommand, namespaceHelperSource } from "./BridgeNamespace.ts";
import { verifyNamespacePrerequisites } from "./BridgeRuntime.ts";
import { BridgeIsolationUnavailable } from "./BridgePolicy.ts";
import type { BridgeProfile } from "./BridgeTopology.ts";

// Independent native processes and explicitly controlled session scopes must survive
// separate Promise/event phases; this runner is confined to that OS harness.
const runNative = <A, E>(effect: Effect.Effect<A, E>) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Native OS ownership harness needs independent scopes across Promise events.
  Effect.runPromise(effect);

const probeSource = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const name = process.argv[2];
const key = process.argv[3];
const abstract = '\0t3-bridge-' + name;
fs.writeFileSync(process.cwd() + '/marker', name);
fs.writeFileSync(process.env.HOME + '/marker', name);
const read = path => { try { return fs.readFileSync(path, 'utf8'); } catch { return null; } };
const connect = options => new Promise((resolve, reject) => {
  const socket = net.connect(options);
  const guard = setTimeout(() => { socket.destroy(); reject(new Error('probe connect did not settle')); }, 2000);
  socket.once('error', error => { clearTimeout(guard); resolve({ connected: false, code: error.code }); });
  socket.once('connect', () => {
    if (options.path || options.port === 18080) {
      socket.once('data', data => {
        clearTimeout(guard); socket.end(); resolve({ connected: true, greeting: data.toString() });
      });
    } else { clearTimeout(guard); socket.end(); resolve({ connected: true }); }
  });
});
const echo = net.createServer(socket => socket.end(name));
const cleanup = net.createServer(socket => {
  socket.on('error', () => {});
  socket.once('data', data => {
    if (data.toString() === name) socket.end('fixture stopped', () => process.exit(0));
    else socket.destroy();
  });
}).listen(process.cwd() + '/fixture-exit.sock');
echo.listen(abstract, () => console.log(JSON.stringify({ ready: name, pid: process.pid })));
readline.createInterface({ input: process.stdin }).on('line', async line => {
  try {
    const input = JSON.parse(line);
    if (input.op === 'probe') {
      let readonly = false;
      try { fs.writeFileSync('/runtime/usr/bin/forbidden', 'bad'); } catch (error) { readonly = error.code === 'EROFS'; }
      // Read only regular descriptors; reading the protocol pipes would block.
      const descriptors = fs.readdirSync('/proc/self/fd').flatMap(fd => {
        try { return fs.statSync('/proc/self/fd/' + fd).isFile() ? [read('/proc/self/fd/' + fd)] : []; }
        catch { return []; }
      });
      console.log(JSON.stringify({
        own: read(process.cwd() + '/marker'), home: read(process.env.HOME + '/marker'),
        cwd: fs.readlinkSync('/proc/self/cwd'), ownProc: read('/proc/self/status'),
        environ: read('/proc/self/environ'), env: process.env, descriptors,
        keyring: JSON.parse(execFileSync('/runtime/usr/bin/key-probe', [key, input.siblingKey], { encoding: 'utf8' })),
        paths: input.paths.map(read), readonly,
        proc: fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)),
        endpoints: await Promise.all(input.endpoints.map(connect)),
      }));
    } else if (input.op === 'ping') console.log(JSON.stringify({ pong: name }));
    else if (input.op === 'exit') process.exit(0);
  } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
});
`;

// The launcher first joins a fresh anonymous ring, so the test never searches
// or mutates the developer's inherited ring. Only its synthetic key is read.
const keyringSource = String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <linux/keyctl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 3) return 125;
  if (!strcmp(argv[1], "launch")) {
    if (syscall(SYS_keyctl, KEYCTL_JOIN_SESSION_KEYRING, NULL) < 0) return 126;
    const char *value = "synthetic-keyring-canary";
    long key = syscall(SYS_add_key, "user", "t3-native-canary", value, strlen(value), KEY_SPEC_SESSION_KEYRING);
    char buffer[128] = {0};
    if (key < 0 || syscall(SYS_keyctl, KEYCTL_READ, key, buffer, sizeof(buffer)) != (long)strlen(value) || strcmp(buffer, value)) return 126;
    char serial[32]; snprintf(serial, sizeof(serial), "%ld", key);
    printf("{\"hostKey\":\"synthetic-keyring-canary\",\"key\":\"%s\"}\n", serial); fflush(stdout);
    char **command = calloc((size_t)argc, sizeof(char *));
    if (!command) return 125;
    for (int i = 2; i < argc; i++) command[i - 2] = argv[i];
    command[argc - 2] = serial;
    execv(command[0], command);
    return 125;
  }
  char buffer[128];
  errno = 0; long read_own = syscall(SYS_keyctl, KEYCTL_READ, strtol(argv[1], NULL, 10), buffer, sizeof(buffer)); int own_error = errno;
  errno = 0; long read_sibling = syscall(SYS_keyctl, KEYCTL_READ, strtol(argv[2], NULL, 10), buffer, sizeof(buffer)); int sibling_error = errno;
  errno = 0; long search = syscall(SYS_keyctl, KEYCTL_SEARCH, KEY_SPEC_SESSION_KEYRING, "user", "t3-native-canary", 0); int search_error = errno;
  errno = 0; long add = syscall(SYS_add_key, "user", "sandbox-key", "x", 1, KEY_SPEC_SESSION_KEYRING); int add_error = errno;
  errno = 0; long request = syscall(SYS_request_key, "user", "t3-native-canary", NULL, 0); int request_error = errno;
  printf("{\"readOwn\":%ld,\"ownErrno\":%d,\"readSibling\":%ld,\"siblingErrno\":%d,\"search\":%ld,\"searchErrno\":%d,\"add\":%ld,\"addErrno\":%d,\"request\":%ld,\"requestErrno\":%d}\n", read_own, own_error, read_sibling, sibling_error, search, search_error, add, add_error, request, request_error);
  return 0;
}
`;

async function runtimeImage(root: string) {
  await NodeFSP.mkdir(NodePath.join(root, "usr/bin"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, "etc"), { recursive: true });
  await NodeFSP.copyFile(process.execPath, NodePath.join(root, "usr/bin/node"));
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Native namespace/compiler proof must inspect the actual host, not an injected simulation.
  if (process.platform !== "linux") return;
  const paths = NodeChildProcess.execFileSync("ldd", [process.execPath], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => line.match(/(?:=>\s*)?(\/[^\s]+)\s+\(/)?.[1] ?? []);
  expect(paths.length).toBeGreaterThan(0);
  for (const file of paths) {
    const destination = NodePath.join(root, file);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.copyFile(file, destination);
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

async function listen(server: NodeNet.Server, options: NodeNet.ListenOptions) {
  server.listen(options);
  await NodeEvents.EventEmitter.once(server, "listening");
  return server;
}

function close(server: NodeNet.Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function echoServer(message: string) {
  return NodeNet.createServer((socket) => {
    // Namespace teardown may reset an established fixture connection.
    socket.on("error", () => {});
    socket.end(message);
  });
}

async function recordTree(
  owner: number,
): Promise<ReadonlyArray<{ pid: number; start: string; namespace: string }>> {
  const children = (await NodeFSP.readFile(`/proc/${owner}/task/${owner}/children`, "utf8"))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  return (
    await Promise.all(
      children.map(async (pid) => [
        {
          pid,
          start: await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8"),
          namespace: await NodeFSP.readlink(`/proc/${pid}/ns/pid`),
        },
        ...(await recordTree(pid)),
      ]),
    )
  ).flat();
}

function launch(
  input: Parameters<typeof buildNamespaceCommand>[0],
  supervisorPath: string,
  keyProbe: string,
) {
  const command = buildNamespaceCommand(input);
  const child = NodeChildProcess.spawn(
    keyProbe,
    ["launch", supervisorPath, command.command, ...command.args],
    {
      env: command.options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  const exit = NodeEvents.EventEmitter.once(child, "exit");
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  // Production closes this custody-only startup descriptor before any bwrap
  // or model process exists; model code receives only the protocol pipes.
  child.stdio[3]!.on("data", () => {});
  const lines = NodeReadline.createInterface({ input: child.stdout! });
  const queued: string[] = [];
  let waiter: ((line: string) => void) | undefined;
  lines.on("line", (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(line);
    } else queued.push(line);
  });
  const next = async (): Promise<Record<string, unknown>> => {
    const line = queued.shift();
    if (line !== undefined) return JSON.parse(line) as Record<string, unknown>;
    return Promise.race([
      new Promise<Record<string, unknown>>((resolve) => {
        waiter = (value) => resolve(JSON.parse(value) as Record<string, unknown>);
      }),
      exit.then(() => {
        throw new Error(`namespace exited before response: ${stderr}`);
      }),
    ]);
  };
  return {
    pid: child.pid!,
    next,
    request: (message: object) => {
      child.stdin!.write(`${JSON.stringify(message)}\n`);
      return next();
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exit;
      lines.close();
    },
  };
}

describe("real Linux bridge namespace", () => {
  it("confines two simultaneous executors in both directions while their own resources work", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ns-"));
    await runNative(Effect.logInfo(`Owned native fixture: ${root}`));
    const servers: NodeNet.Server[] = [];
    const children: ReturnType<typeof launch>[] = [];
    const environmentKey = "T3_BRIDGE_NATIVE_HOST_CANARY";
    const previous = process.env[environmentKey];
    process.env[environmentKey] = "synthetic-host-secret";
    const hostCanary = NodePath.join(root, "host-oauth-canary");
    const hostFd = await NodeFSP.open(hostCanary, "w+", 0o600);
    try {
      await hostFd.writeFile("synthetic-host-secret");
      const runtimeRoot = NodePath.join(root, "image");
      await runtimeImage(runtimeRoot);
      await NodeFSP.writeFile(
        NodePath.join(runtimeRoot, "usr/bin/codex"),
        "#!/runtime/usr/bin/node\nconsole.log('codex-cli 0.162.0');\n",
        { mode: 0o755 },
      );
      const stateRoot = NodePath.join(root, "state");
      await NodeFSP.mkdir(stateRoot);
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
      if (
        !(await nativePrerequisites({
          custodyUid: process.getuid?.() ?? 0,
          custodyGid: process.getgid?.() ?? 0,
          exclusiveCustodyUid: true,
          serviceUnit: NodePath.join(root, "fixture.service"),
          cgroup: "/fixture",
          installedRoot: root,
          runtimeRoot,
          workspaceRoot: root,
          stateRoot,
          bwrapPath: "/usr/bin/bwrap",
          supervisorPath,
          codexPath: "/runtime/usr/bin/codex",
        }))
      )
        return;
      const keyProbeSource = NodePath.join(root, "key-probe.c");
      const keyProbe = NodePath.join(root, "key-probe");
      await NodeFSP.writeFile(keyProbeSource, keyringSource);
      NodeChildProcess.execFileSync("cc", [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        keyProbeSource,
        "-o",
        keyProbe,
      ]);
      await NodeFSP.copyFile(keyProbe, NodePath.join(runtimeRoot, "usr/bin/key-probe"));
      await NodeFSP.writeFile(NodePath.join(runtimeRoot, "usr/bin/probe.cjs"), probeSource);
      const helperPath = NodePath.join(root, "helper.cjs");
      await NodeFSP.writeFile(helperPath, namespaceHelperSource);
      const proxySocket = NodePath.join(root, "egress.sock");
      servers.push(await listen(echoServer("authorized-fixture-egress"), { path: proxySocket }));
      const hostSocket = NodePath.join(root, "custody.sock");
      servers.push(await listen(echoServer("host"), { path: hostSocket }));
      const hostAbstract = `\0t3-custody-${NodePath.basename(root)}`;
      servers.push(await listen(echoServer("host"), { path: hostAbstract }));
      const hostTcp = await listen(echoServer("host"), { host: "0.0.0.0", port: 0 });
      servers.push(hostTcp);
      const address = hostTcp.address();
      if (!address || typeof address === "string")
        throw new Error("missing native TCP fixture address");
      const local = Object.values(NodeOS.networkInterfaces())
        .flat()
        .find((entry) => entry?.family === "IPv4" && !entry.internal);
      expect(
        local,
        "a host local address is required for the network confinement probe",
      ).toBeDefined();
      const instances = await Promise.all(
        ["a", "b"].map(async (name) => {
          const workspace = NodePath.join(root, name, "workspace");
          const home = NodePath.join(root, name, "home");
          await NodeFSP.mkdir(workspace, { recursive: true });
          await NodeFSP.mkdir(home, { recursive: true });
          const child = launch(
            {
              bwrapPath: "/usr/bin/bwrap",
              runtimeRoot,
              workspace,
              home,
              proxySocket,
              helperPath,
              executable: "/runtime/usr/bin/node",
              args: ["/runtime/usr/bin/probe.cjs", `${NodePath.basename(root)}-${name}`],
            },
            supervisorPath,
            keyProbe,
          );
          children.push(child);
          await NodeFSP.writeFile(
            NodePath.join(workspace, "fixture-owner.json"),
            JSON.stringify({
              token: `${NodePath.basename(root)}-${name}`,
              parent: process.pid,
              supervisor: child.pid,
              supervisorStart: await NodeFSP.readFile(`/proc/${child.pid}/stat`, "utf8"),
              exitSocket: NodePath.join(workspace, "fixture-exit.sock"),
            }),
            { mode: 0o600 },
          );
          const hostKey = await child.next();
          expect(hostKey.hostKey).toBe("synthetic-keyring-canary");
          const ready = await child.next();
          expect(ready.ready).toBe(`${NodePath.basename(root)}-${name}`);
          await NodeFSP.writeFile(
            NodePath.join(workspace, "fixture-descendants.json"),
            JSON.stringify(await recordTree(child.pid)),
            { mode: 0o600 },
          );
          return {
            child,
            workspace,
            home,
            name: `${NodePath.basename(root)}-${name}`,
            key: hostKey.key,
          };
        }),
      );
      for (const [index, own] of instances.entries()) {
        const sibling = instances[1 - index]!;
        const paths = [
          hostCanary,
          `/proc/${process.pid}/root${hostCanary}`,
          `/proc/${process.pid}/environ`,
          `/proc/${process.pid}/cwd/AGENTS.md`,
          `/proc/${process.pid}/fd/${hostFd.fd}`,
          `/proc/1/root${hostCanary}`,
          NodePath.join(sibling.workspace, "marker"),
          NodePath.join(sibling.home, "marker"),
          `/proc/${sibling.child.pid}/root${NodePath.join(sibling.home, "marker")}`,
        ];
        const result = await own.child.request({
          op: "probe",
          paths,
          siblingKey: sibling.key,
          endpoints: [
            { path: `\0t3-bridge-${own.name}` },
            { host: "127.0.0.1", port: 18080 },
            { path: hostSocket },
            { path: hostAbstract },
            { path: `\0t3-bridge-${sibling.name}` },
            { host: "127.0.0.1", port: address.port },
            { host: local!.address, port: address.port },
          ],
        });
        expect(result.error).toBeUndefined();
        expect(result.own).toBe(own.name);
        expect(result.home).toBe(own.name);
        expect(result.cwd).toBe(own.workspace);
        expect(result.ownProc).toContain("Name:");
        expect(result.environ).toContain("HOME=/home/runtime");
        expect(JSON.stringify(result.env)).not.toContain("synthetic-host-secret");
        expect(JSON.stringify(result.descriptors)).not.toContain("synthetic-host-secret");
        expect(result.paths).toEqual(paths.map(() => null));
        expect(result.readonly).toBe(true);
        expect(result.keyring).toEqual({
          readOwn: -1,
          ownErrno: 1,
          readSibling: -1,
          siblingErrno: 1,
          search: -1,
          searchErrno: 1,
          add: -1,
          addErrno: 1,
          request: -1,
          requestErrno: 1,
        });
        expect(result.proc).not.toContain(String(process.pid));
        expect(result.proc).not.toContain(String(sibling.child.pid));
        expect(result.endpoints).toMatchObject([
          { connected: true, greeting: own.name },
          { connected: true, greeting: "authorized-fixture-egress" },
          { connected: false },
          { connected: false },
          { connected: false },
          { connected: false },
          { connected: false },
        ]);
        expect(await own.child.request({ op: "ping" })).toEqual({ pong: own.name });
      }
      expect(await NodeFSP.readFile(hostCanary, "utf8")).toBe("synthetic-host-secret");
    } finally {
      await Promise.all(children.map((child) => child.stop()));
      await Promise.all(servers.map(close));
      await hostFd.close();
      if (previous === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = previous;
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
