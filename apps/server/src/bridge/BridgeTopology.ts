// @effect-diagnostics nodeBuiltinImport:off -- Admission inspects Linux custody and immutable deployment metadata.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ServerConfig } from "../config.ts";
import { BridgeIsolationUnavailable, bridgeProfilePath } from "./BridgePolicy.ts";

export const BridgeProfile = Schema.Struct({
  custodyUid: Schema.Int,
  custodyGid: Schema.Int,
  exclusiveCustodyUid: Schema.Literal(true),
  serviceUnit: Schema.String,
  cgroup: Schema.String,
  installedRoot: Schema.String,
  runtimeRoot: Schema.String,
  workspaceRoot: Schema.String,
  stateRoot: Schema.String,
  bwrapPath: Schema.String,
  supervisorPath: Schema.String,
  codexPath: Schema.String,
});
export type BridgeProfile = typeof BridgeProfile.Type;

const refuse = (reason: BridgeIsolationUnavailable["reason"]): never => {
  throw new BridgeIsolationUnavailable({ reason });
};

const contained = (parent: string, child: string) => child.startsWith(`${parent}/`);

/** Parents cannot be replaced by the custody UID, including through a symlink. */
async function assertOperatorOwned(path: string): Promise<void> {
  if (!NodePath.isAbsolute(path) || NodePath.normalize(path) !== path)
    refuse("untrusted-deployment");
  let current = path;
  for (;;) {
    const stat = await NodeFSP.lstat(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
      refuse("untrusted-deployment");
    if (current === "/") break;
    current = NodePath.dirname(current);
  }
}

async function assertImmutableTree(root: string, treeRoot = root) {
  await assertOperatorOwned(root);
  for (const entry of await NodeFSP.readdir(root, { withFileTypes: true })) {
    const target = NodePath.join(root, entry.name);
    const stat = await NodeFSP.lstat(target);
    if (stat.uid !== 0 || (!entry.isSymbolicLink() && (stat.mode & 0o022) !== 0))
      refuse("untrusted-deployment");
    if (entry.isDirectory()) await assertImmutableTree(target, treeRoot);
    else if (entry.isSymbolicLink()) {
      const resolved = await NodeFSP.realpath(target);
      if (!contained(treeRoot, resolved)) refuse("untrusted-deployment");
    } else if (!entry.isFile()) refuse("untrusted-deployment");
  }
}

/** Administrator UID allocation is a prerequisite; process enumeration cannot establish it. */
async function validateBridgeTopology(profile: BridgeProfile): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Admission must verify the real kernel platform, never an injectable claim.
  if (process.platform !== "linux") refuse("unsupported-platform");
  if (
    profile.custodyUid <= 0 ||
    process.getuid?.() !== profile.custodyUid ||
    process.getgid?.() !== profile.custodyGid ||
    process.getgroups?.().some((gid) => gid !== profile.custodyGid)
  )
    refuse("unsupported-topology");
  const passwd = (await NodeFSP.readFile("/etc/passwd", "utf8"))
    .split("\n")
    .map((line) => line.split(":"));
  const account = passwd.find((row) => Number(row[2]) === profile.custodyUid);
  if (!account) return refuse("unsupported-topology");
  if (!["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"].includes(account[6]!))
    refuse("unsupported-topology");
  if (
    process.ppid !== 1 ||
    !(await NodeFSP.readlink("/proc/1/exe")).endsWith("/systemd") ||
    (await NodeFSP.readFile("/proc/self/cgroup", "utf8")).trim() !== `0::${profile.cgroup}` ||
    profile.cgroup !== `/system.slice/${NodePath.basename(profile.serviceUnit)}`
  )
    refuse("unsupported-topology");
  await assertOperatorOwned(profile.serviceUnit);
  const unit = await NodeFSP.readFile(profile.serviceUnit, "utf8");
  for (const [key, value] of [
    ["User", account[0]],
    ["KillMode", "control-group"],
    ["NoNewPrivileges", "yes"],
  ]) {
    const values = unit
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => new RegExp(`^${key}\\s*=`).test(line));
    if (values.length !== 1 || values[0] !== `${key}=${value}`) refuse("unsupported-topology");
  }
  if (!/^NoNewPrivs:\s+1$/m.test(await NodeFSP.readFile("/proc/self/status", "utf8")))
    refuse("unsupported-topology");
  if (/^\s*(EnvironmentFile|\.include)\s*=/m.test(unit)) refuse("unsupported-topology");
  const unitName = NodePath.basename(profile.serviceUnit);
  const dropIns = [
    "service.d",
    `${unitName}.d`,
    ...Array.from(
      unitName.matchAll(/-/g),
      (match) => `${unitName.slice(0, match.index + 1)}.service.d`,
    ),
  ];
  for (const directory of [
    "/etc/systemd/system",
    "/run/systemd/system",
    "/usr/lib/systemd/system",
  ]) {
    for (const name of dropIns)
      if (
        await NodeFSP.stat(NodePath.join(directory, name)).then(
          () => true,
          () => false,
        )
      )
        refuse("unsupported-topology");
    const candidate = NodePath.join(directory, NodePath.basename(profile.serviceUnit));
    if (
      candidate !== profile.serviceUnit &&
      (await NodeFSP.lstat(candidate).then(
        () => true,
        () => false,
      ))
    )
      refuse("unsupported-topology");
  }
  await assertImmutableTree(profile.installedRoot);
  await assertImmutableTree(profile.runtimeRoot);
  await assertOperatorOwned(profile.bwrapPath);
  await assertOperatorOwned(profile.supervisorPath);
  for (const executable of [profile.bwrapPath, profile.supervisorPath]) {
    const binary = await NodeFSP.lstat(executable);
    if (!binary.isFile() || (binary.mode & 0o111) === 0 || (binary.mode & 0o6000) !== 0)
      refuse("untrusted-deployment");
  }
  const entrypoint = await NodeFSP.realpath(process.argv[1]!);
  const node = await NodeFSP.realpath(process.execPath);
  if (!contained(profile.installedRoot, entrypoint)) refuse("untrusted-deployment");
  await assertOperatorOwned(node);
  if (!profile.codexPath.startsWith("/runtime/") || profile.codexPath.includes(".."))
    refuse("untrusted-deployment");
  for (const executable of [
    NodePath.join(profile.runtimeRoot, "usr/bin/node"),
    NodePath.join(profile.runtimeRoot, profile.codexPath.slice("/runtime/".length)),
  ]) {
    const stat = await NodeFSP.lstat(executable);
    if (!stat.isFile() || (stat.mode & 0o111) === 0 || stat.uid !== 0 || (stat.mode & 0o6022) !== 0)
      refuse("untrusted-deployment");
  }
  for (const path of [profile.workspaceRoot, profile.stateRoot]) {
    if (
      !NodePath.isAbsolute(path) ||
      NodePath.normalize(path) !== path ||
      (await NodeFSP.realpath(path)) !== path
    )
      refuse("unsupported-topology");
    const stat = await NodeFSP.stat(path);
    if (!stat.isDirectory() || stat.uid !== profile.custodyUid || (stat.mode & 0o077) !== 0)
      refuse("unsupported-topology");
    await assertOperatorOwned(NodePath.dirname(path));
  }
  const roots = [
    profile.workspaceRoot,
    profile.stateRoot,
    profile.runtimeRoot,
    profile.installedRoot,
  ];
  if (
    roots.some((left, index) =>
      roots.some((right, other) => index !== other && (left === right || contained(left, right))),
    )
  )
    refuse("unsupported-topology");
  // A sweep only detects a violated allocation; it never proves exclusive custody.
  for (const name of await NodeFSP.readdir("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const stat = await NodeFSP.stat(`/proc/${name}`).catch(() => undefined);
    if (stat?.uid === profile.custodyUid) refuse("unsupported-topology");
  }
}

const isIsolationUnavailable = Schema.is(BridgeIsolationUnavailable);
const untrustedDeployment = (cause: unknown) =>
  isIsolationUnavailable(cause)
    ? cause
    : new BridgeIsolationUnavailable({ reason: "untrusted-deployment", cause });

const decodeBridgeProfile = Schema.decodeEffect(Schema.fromJsonString(BridgeProfile));

/** Mandatory admission shared by server startup and offline provisioning. */
export const loadAdmittedBridgeProfile = Effect.gen(function* () {
  const profilePath = bridgeProfilePath;
  if (profilePath === undefined)
    return yield* new BridgeIsolationUnavailable({ reason: "unsupported-topology" });
  const source = yield* Effect.tryPromise({
    try: async () => {
      await assertOperatorOwned(profilePath);
      return NodeFSP.readFile(profilePath, "utf8");
    },
    catch: untrustedDeployment,
  });
  const profile = yield* decodeBridgeProfile(source).pipe(Effect.mapError(untrustedDeployment));
  yield* Effect.tryPromise({
    try: () => validateBridgeTopology(profile),
    catch: untrustedDeployment,
  });
  return profile;
});

export const admitBridgeProfile = (config: ServerConfig["Service"]) =>
  Effect.gen(function* () {
    if (bridgeProfilePath === undefined) return undefined;
    if (
      config.mode !== "web" ||
      config.devUrl ||
      config.tailscaleServeEnabled ||
      !config.noBrowser ||
      (config.host !== undefined && config.host !== "127.0.0.1")
    )
      return yield* new BridgeIsolationUnavailable({ reason: "unsupported-connection" });
    return yield* loadAdmittedBridgeProfile;
  });
