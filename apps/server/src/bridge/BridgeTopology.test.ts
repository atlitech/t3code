// @effect-diagnostics nodeBuiltinImport:off -- Unit admission fixtures model OS authority; the separate read-only test inspects real PID 1 metadata.
import * as NodeProcess from "node:process";
import * as NodeFSP from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, vi } from "vite-plus/test";

const facts = vi.hoisted(() => ({
  parent: 1,
  initUid: 0,
  initName: "systemd\n",
  initSymlink: false,
  cgroup: "0::/system.slice/t3-bridge.service\n",
  unit: "[Service]\nUser=bridge\nKillMode=control-group\nNoNewPrivileges=yes\n",
  runtimeMode: 0o755,
  extraCustodyProcess: false,
}));
const profile = vi.hoisted(() => ({
  custodyUid: 991,
  custodyGid: 991,
  exclusiveCustodyUid: true,
  serviceUnit: "/etc/systemd/system/t3-bridge.service",
  cgroup: "/system.slice/t3-bridge.service",
  installedRoot: "/opt/t3/server",
  runtimeRoot: "/opt/t3/runtime",
  workspaceRoot: "/srv/workspaces",
  stateRoot: "/var/lib/bridge",
  bwrapPath: "/usr/bin/bwrap",
  supervisorPath: "/opt/t3/supervisor",
  codexPath: "/runtime/usr/bin/codex",
}));
const os = vi.hoisted(() => {
  const directories = new Set([
    "/",
    "/etc",
    "/etc/systemd",
    "/etc/systemd/system",
    "/opt",
    "/opt/t3",
    "/opt/t3/server",
    "/opt/t3/runtime",
    "/opt/t3/runtime/usr",
    "/opt/t3/runtime/usr/bin",
    "/usr",
    "/usr/bin",
    "/srv",
    "/var",
    "/var/lib",
    "/srv/workspaces",
    "/var/lib/bridge",
    "/proc/1",
    "/proc/4242",
  ]);
  const files = new Set([
    "/etc/t3-bridge.json",
    "/etc/systemd/system/t3-bridge.service",
    "/opt/t3/server/bin.mjs",
    "/usr/bin/bwrap",
    "/usr/bin/node",
    "/opt/t3/supervisor",
    "/opt/t3/runtime/usr/bin/node",
    "/opt/t3/runtime/usr/bin/codex",
  ]);
  const absent = new Set<string>();
  for (const root of ["/etc/systemd/system", "/run/systemd/system", "/usr/lib/systemd/system"]) {
    for (const name of ["service.d", "t3-bridge.service.d", "t3-.service.d"])
      absent.add(`${root}/${name}`);
    if (root !== "/etc/systemd/system") absent.add(`${root}/t3-bridge.service`);
  }
  const stat = (path: string) => {
    if (absent.has(path)) throw Object.assign(new Error("absent fixture path"), { code: "ENOENT" });
    if (!directories.has(path) && !files.has(path) && path !== "/proc/5000")
      throw new Error(`Unexpected fixture stat: ${path}`);
    const privateRoot = path === "/srv/workspaces" || path === "/var/lib/bridge";
    return {
      uid: path === "/proc/1" ? facts.initUid : privateRoot || path === "/proc/5000" ? 991 : 0,
      mode: path === "/opt/t3/runtime" ? facts.runtimeMode : privateRoot ? 0o700 : 0o755,
      isSymbolicLink: () => path === "/proc/1" && facts.initSymlink,
      isDirectory: () => directories.has(path),
      isFile: () => files.has(path),
    };
  };
  return {
    stat,
    readlink: vi.fn(async () => {
      throw Object.assign(new Error("executable link permission denied"), { code: "EACCES" });
    }),
  };
});

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(async (path: string) => os.stat(path)),
  stat: vi.fn(async (path: string) => os.stat(path)),
  readlink: os.readlink,
  realpath: vi.fn(async (path: string) => {
    os.stat(path);
    return path;
  }),
  readFile: vi.fn(async (path: string) => {
    switch (path) {
      case "/etc/t3-bridge.json":
        return JSON.stringify(profile);
      case "/etc/passwd":
        return "bridge:x:991:991::/nonexistent:/usr/sbin/nologin\n";
      case "/proc/1/comm":
        return facts.initName;
      case "/proc/self/cgroup":
        return facts.cgroup;
      case "/proc/self/status":
        return "NoNewPrivs:\t1\n";
      case "/etc/systemd/system/t3-bridge.service":
        return facts.unit;
      default:
        throw new Error(`Unexpected fixture read: ${path}`);
    }
  }),
  readdir: vi.fn(async (path: string) => {
    if (path === "/proc") return facts.extraCustodyProcess ? ["1", "4242", "5000"] : ["1", "4242"];
    const names =
      path === "/opt/t3/server"
        ? ["bin.mjs"]
        : path === "/opt/t3/runtime"
          ? ["usr"]
          : path === "/opt/t3/runtime/usr"
            ? ["bin"]
            : path === "/opt/t3/runtime/usr/bin"
              ? ["node", "codex"]
              : undefined;
    if (!names) throw new Error(`Unexpected fixture readdir: ${path}`);
    return names.map((name) => ({
      name,
      isDirectory: () => os.stat(`${path}/${name}`).isDirectory(),
      isSymbolicLink: () => false,
      isFile: () => os.stat(`${path}/${name}`).isFile(),
    }));
  }),
}));

const admission = Effect.gen(function* () {
  vi.resetModules();
  vi.stubEnv("T3CODE_BRIDGE_PROFILE", "/etc/t3-bridge.json");
  vi.stubGlobal("process", {
    ...NodeProcess,
    platform: "linux",
    ppid: facts.parent,
    pid: 4242,
    argv: ["/usr/bin/node", "/opt/t3/server/bin.mjs"],
    execPath: "/usr/bin/node",
    getuid: () => 991,
    getgid: () => 991,
    getgroups: () => [991],
  });
  const topology = yield* Effect.promise(() => import("./BridgeTopology.ts"));
  return yield* topology.loadAdmittedBridgeProfile.pipe(Effect.result);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  Object.assign(facts, {
    parent: 1,
    initUid: 0,
    initName: "systemd\n",
    initSymlink: false,
    cgroup: "0::/system.slice/t3-bridge.service\n",
    unit: "[Service]\nUser=bridge\nKillMode=control-group\nNoNewPrivileges=yes\n",
    runtimeMode: 0o755,
    extraCustodyProcess: false,
  });
});

describe("dedicated service topology authority observations", () => {
  it.effect(
    "admits a complete supported deployment without reading the inaccessible PID 1 executable",
    () =>
      Effect.gen(function* () {
        const result = yield* admission;
        expect(result).toMatchObject({ _tag: "Success", success: profile });
        expect(os.readlink).not.toHaveBeenCalled();
      }),
  );

  it.effect.each([
    ["wrong direct parent", { parent: 2 }, "unsupported-topology"],
    ["non-root PID 1", { initUid: 991 }, "unsupported-topology"],
    ["symlink PID 1", { initSymlink: true }, "unsupported-topology"],
    ["non-systemd PID 1", { initName: "other\n" }, "unsupported-topology"],
    ["wrong cgroup", { cgroup: "0::/other\n" }, "unsupported-topology"],
    [
      "unsafe unit",
      { unit: "User=bridge\nKillMode=process\nNoNewPrivileges=yes\n" },
      "unsupported-topology",
    ],
    ["writable runtime", { runtimeMode: 0o777 }, "untrusted-deployment"],
    ["another custody process", { extraCustodyProcess: true }, "unsupported-topology"],
  ] as const)("refuses %s", ([, mutation, reason]) =>
    Effect.gen(function* () {
      Object.assign(facts, mutation);
      const result = yield* admission;
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ _tag: "BridgeIsolationUnavailable", reason });
    }),
  );

  it.effect("reads actual PID 1 directory and comm without executable-link permission", () =>
    Effect.gen(function* () {
      const actual = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      // This is only kernel-read proof on Linux, never proof of the fixture's deployment claims.
      if (NodeProcess.platform !== "linux") return;
      const stat = yield* Effect.promise(() => actual.lstat("/proc/1"));
      const comm = yield* Effect.promise(() => actual.readFile("/proc/1/comm", "utf8"));
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.uid).toBe(0);
      expect(comm.trim().length).toBeGreaterThan(0);
    }),
  );
});
