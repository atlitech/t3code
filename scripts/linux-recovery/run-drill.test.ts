// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Drives run-drill.sh against a fake release server; the stub t3 it serializes into each archive runs outside Effect.
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const hostPlatform = HostProcessPlatform.defaultValue();
const platformArch = `${hostPlatform}-${HostProcessArchitecture.defaultValue()}`;
const PRIOR = "0.0.46-atli.3";
const TARGET = "0.0.46-atli.4";
const templateDatabase = NodePath.join(
  import.meta.dirname,
  "../linux-admission/pre-upgrade.sqlite",
);

interface StubConfig {
  readonly version: string;
  readonly recoverHelpFails: boolean;
  readonly platformArch: string;
  readonly template: string;
  readonly callsLog: string;
}

// The `t3` inside each stub archive: it logs every call (its arguments, its
// own version, whether it was given a release base URL, and whether tar is on
// its PATH) and does just enough of each command for the drill to run.
// Serialized with toString(), so it uses nothing from this module's scope.
function stubT3(config: StubConfig) {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const crypto = process.getBuiltinModule("node:crypto");
  const childProcess = process.getBuiltinModule("node:child_process");
  const http = process.getBuiltinModule("node:http");
  const [self = "", ...args] = process.argv.slice(2);
  const env = process.env;
  const onPath = (tool: string) =>
    (env["PATH"] ?? "").split(":").some((dir) => dir !== "" && fs.existsSync(path.join(dir, tool)));
  fs.appendFileSync(
    config.callsLog,
    `${JSON.stringify({
      t3: config.version,
      args,
      releaseBaseUrl: env["T3CODE_RELEASE_BASE_URL"] ?? null,
      tar: onPath("tar"),
    })}\n`,
  );
  const home = env["T3CODE_HOME"] ?? "";
  const userdata = path.join(home, "userdata");
  const db = path.join(userdata, "statev2.sqlite");
  const versions = path.join(home, "runtime", "versions");
  const sha256 = (file: string) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const compactUtc = () => new Date().toISOString().replace(/[-:.]/g, "");
  const repoint = (version: string) => {
    if (fs.lstatSync(self).isSymbolicLink()) {
      fs.rmSync(self);
      fs.symlinkSync(path.join(versions, version, "t3"), self);
    }
  };
  const [command, ...rest] = args;
  if (command === "--version") {
    console.log(`t3 v${config.version}`);
  } else if (command === "recover" && rest[0] === "--help") {
    if (config.recoverHelpFails) {
      console.error("Unknown subcommand: recover");
      process.exit(1);
    }
    console.log("t3 recover [--list] [id]");
  } else if (command === "auth") {
    console.log("drill-test-token");
  } else if (command === "serve") {
    const port = Number(rest[rest.indexOf("--port") + 1]);
    fs.mkdirSync(userdata, { recursive: true });
    if (!fs.existsSync(db)) fs.copyFileSync(config.template, db);
    const idFile = path.join(userdata, "environment-id");
    if (!fs.existsSync(idFile)) fs.writeFileSync(idFile, `environment-${crypto.randomUUID()}\n`);
    fs.writeFileSync(
      path.join(userdata, "server-runtime.json"),
      JSON.stringify({ pid: process.pid }),
    );
    const server = http.createServer((request, response) => {
      if (request.url === "/.well-known/t3/environment") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            environmentId: fs.readFileSync(idFile, "utf8").trim(),
            serverVersion: config.version,
          }),
        );
      } else {
        response.end("ok");
      }
    });
    server.listen(port, "127.0.0.1");
    process.on("SIGTERM", () => {
      server.close();
      process.exit(0);
    });
  } else if (command === "update") {
    const target = rest[0] ?? "";
    const archive = `t3-${target}-${config.platformArch}.tar.gz`;
    const download = fs.mkdtempSync(path.join(env["TMPDIR"] ?? "/tmp", "update-"));
    childProcess.execFileSync(
      "curl",
      [
        "-fsSL",
        "-o",
        path.join(download, archive),
        `${env["T3CODE_RELEASE_BASE_URL"]}/v${target}/${archive}`,
      ],
      { env },
    );
    const runtime = path.join(versions, target);
    fs.mkdirSync(runtime, { recursive: true });
    childProcess.execFileSync(
      "tar",
      ["-xzf", path.join(download, archive), "-C", runtime, "--strip-components=1"],
      { env },
    );
    fs.writeFileSync(
      path.join(runtime, ".archive-sha256"),
      `${sha256(path.join(download, archive))}\n`,
    );
    const id = `${compactUtc()}-${config.version}-to-${target}`;
    const pointDir = path.join(home, "recovery", "points", id);
    const snapshot = path.join(pointDir, "statev2.sqlite");
    fs.mkdirSync(pointDir, { recursive: true });
    fs.copyFileSync(db, snapshot);
    const createdAt = new Date().toISOString();
    const record = {
      id,
      createdAt,
      from: {
        version: config.version,
        runtimePath: path.join(versions, config.version, "t3"),
        archiveSha256: fs
          .readFileSync(path.join(versions, config.version, ".archive-sha256"), "utf8")
          .trim(),
      },
      to: { version: target },
      snapshot: { size: fs.statSync(snapshot).size, sha256: sha256(snapshot) },
      actions: [{ at: createdAt, action: "kept the recovery point" }],
    };
    fs.writeFileSync(path.join(pointDir, "recovery.json"), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`  Kept recovery point ${id} (${pointDir}); \`t3 recover ${id}\` restores it.`);
    repoint(target);
  } else if (command === "recover") {
    const id = rest[0] ?? "";
    const state = path.join(userdata, "server-runtime.json");
    if (fs.existsSync(state)) {
      const { pid } = JSON.parse(fs.readFileSync(state, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) {
        console.error(`Not recovering: a server (pid ${pid}) is running on this T3 home.`);
        process.exit(1);
      }
    }
    const pointDir = path.join(home, "recovery", "points", id);
    const record = JSON.parse(fs.readFileSync(path.join(pointDir, "recovery.json"), "utf8"));
    console.log(`Recovering ${home} to t3@${record.from.version} from recovery point ${id}.`);
    const displaced = path.join(home, "recovery", "displaced", `${compactUtc()}-${id}`);
    fs.mkdirSync(displaced, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${db}${suffix}`)) {
        fs.renameSync(`${db}${suffix}`, path.join(displaced, `statev2.sqlite${suffix}`));
      }
    }
    console.log(`  moved the current database to ${displaced}`);
    fs.copyFileSync(path.join(pointDir, "statev2.sqlite"), db);
    console.log(`  restored the database from recovery point ${id}`);
    repoint(record.from.version);
    console.log(`Recovered to t3@${record.from.version}.`);
  } else {
    console.error(`stub t3: unexpected ${args.join(" ")}`);
    process.exit(2);
  }
}

// What the drill's `node` runs for the admission helpers that would talk to a
// real server: it logs the call and writes what the helper would have. With
// RECOVERY_TEST_READBACK_FAILS set, readback.ts writes a passing result and
// still exits non-zero, an observation that did not complete.
function fakeHelper(config: { readonly callsLog: string }) {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const sqlite = process.getBuiltinModule("node:sqlite");
  const [script = "", ...args] = process.argv.slice(2);
  const flag = (name: string) => args[args.indexOf(`--${name}`) + 1] ?? "";
  const helper = path.basename(script);
  fs.appendFileSync(config.callsLog, `${JSON.stringify({ helper, args })}\n`);
  if (helper === "readback.ts") {
    const stage = flag("stage");
    fs.writeFileSync(
      flag("out"),
      JSON.stringify({
        stage,
        passed: true,
        threads: 3,
        messages: stage === "created" ? 0 : 7,
        events: 0,
        items: [
          { kind: "thread", id: "admission-thread-upgrade-notes", passed: true, detail: "ok" },
        ],
      }),
    );
    if (process.env["RECOVERY_TEST_READBACK_FAILS"] !== undefined) process.exit(1);
  } else if (helper === "seed.ts") {
    fs.writeFileSync(flag("out"), "SELECT 1;\n");
  } else if (helper === "post-upgrade-thread.ts") {
    const database = new sqlite.DatabaseSync(
      path.join(process.env["WORKDIR"] ?? "", "drill/home/userdata/statev2.sqlite"),
    );
    database
      .prepare(
        "INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json, application_event_version) VALUES ('event-post-upgrade', 'thread', 'recovery-drill-post-upgrade', 0, 'thread.created', '2026-10-10T10:13:00.000Z', 'recovery-drill:thread.create:recovery-drill-post-upgrade', 'user', '{}', '{}', 2)",
      )
      .run();
    database.close();
  }
}

const sh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

interface Fixture {
  readonly root: string;
  readonly callsLog: string;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

// A fake release directory served over HTTP: for each version, its stub
// archive for this host, SHA256SUMS, and a pretty-printed ADMISSION.json.
const makeFixture = async (options: { readonly priorRecoverFails: boolean }): Promise<Fixture> => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-recovery-drill-")),
  );
  const callsLog = NodePath.join(root, "calls.ndjson");
  await NodeFSP.writeFile(callsLog, "");
  const files = new Map<string, Buffer | string>();
  for (const [version, priorVersion] of [
    [PRIOR, "0.0.46-atli.2"],
    [TARGET, PRIOR],
  ] as const) {
    const stem = `t3-${version}-${platformArch}`;
    const build = NodePath.join(root, "build", version);
    const script = NodePath.join(root, `stub-t3-${version}.cjs`);
    const config: StubConfig = {
      version,
      recoverHelpFails: version === PRIOR && options.priorRecoverFails,
      platformArch,
      template: templateDatabase,
      callsLog,
    };
    await NodeFSP.writeFile(script, `(${stubT3.toString()})(${JSON.stringify(config)});\n`);
    await NodeFSP.mkdir(NodePath.join(build, stem, "client"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(build, stem, "client/index.html"), "<!doctype html>\n");
    await NodeFSP.writeFile(
      NodePath.join(build, stem, "t3"),
      `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(script)} "$0" "$@"\n`,
      { mode: 0o755 },
    );
    const archivePath = NodePath.join(build, `${stem}.tar.gz`);
    NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", build, stem]);
    const archive = await NodeFSP.readFile(archivePath);
    const archiveSha256 = NodeCrypto.createHash("sha256").update(archive).digest("hex");
    files.set(`/v${version}/${stem}.tar.gz`, archive);
    files.set(`/v${version}/SHA256SUMS`, `${archiveSha256}  ${stem}.tar.gz\n`);
    files.set(
      `/v${version}/ADMISSION.json`,
      `${JSON.stringify(
        {
          version,
          archive: `${stem}.tar.gz`,
          archiveSha256,
          priorVersion,
          priorSource: "admitted",
          verifierCommit: "0".repeat(40),
          checks: [],
        },
        null,
        2,
      )}\n`,
    );
  }
  const fakebin = NodePath.join(root, "fakebin");
  const helper = NodePath.join(root, "fake-helper.cjs");
  await NodeFSP.mkdir(fakebin);
  await NodeFSP.writeFile(helper, `(${fakeHelper.toString()})(${JSON.stringify({ callsLog })});\n`);
  await NodeFSP.writeFile(
    NodePath.join(fakebin, "node"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  */linux-admission/create-threads.ts | */linux-admission/readback.ts | */linux-admission/seed.ts | */linux-recovery/post-upgrade-thread.ts)",
      `    exec ${sh(process.execPath)} ${sh(helper)} "$@" ;;`,
      "esac",
      `exec ${sh(process.execPath)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const server = NodeHttp.createServer((request, response) => {
    const body = files.get(request.url ?? "");
    if (body === undefined) response.writeHead(404).end("Not Found");
    else response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return {
    root,
    callsLog,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
};

// Runs one of this directory's scripts with the fixture's fake `node` first
// on PATH and a scratch HOME, never the developer's own T3 home.
const runScript = async (
  fixture: Fixture,
  script: string,
  env: Readonly<Record<string, string>>,
) => {
  const ambient = { ...process.env };
  delete ambient["T3CODE_HOME"];
  const user = NodePath.join(fixture.root, "user");
  await NodeFSP.mkdir(NodePath.join(user, ".t3"), { recursive: true });
  const child = NodeChildProcess.spawn("bash", [NodePath.join(import.meta.dirname, script)], {
    env: {
      ...ambient,
      HOME: user,
      PATH: `${NodePath.join(fixture.root, "fakebin")}:${ambient["PATH"] ?? ""}`,
      T3CODE_RELEASE_BASE_URL: fixture.baseUrl,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, output };
};

const drill = async (fixture: Fixture) => {
  const result = await runScript(fixture, "run-drill.sh", {
    TARGET_VERSION: TARGET,
    DRILL_COMMIT: "0447af610f0447af610f0447af610f0447af610f",
    WORKDIR: NodePath.join(fixture.root, "work"),
    OUT_DIR: NodePath.join(fixture.root, "out"),
  });
  const calls = (await NodeFSP.readFile(fixture.callsLog, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly t3?: string;
          readonly helper?: string;
          readonly args: ReadonlyArray<string>;
          readonly releaseBaseUrl?: string | null;
          readonly tar?: boolean;
        },
    );
  return { ...result, calls };
};

// The verify job, on its own scratch directory, against the drill's outputs.
const verify = async (
  fixture: Fixture,
  record: string,
  name: string,
  env: Readonly<Record<string, string>> = {},
) => {
  const result = await runScript(fixture, "run-verify.sh", {
    RECORD: record,
    DRILLED_HOME_ARCHIVE: NodePath.join(fixture.root, "out/drilled-home.tar.gz"),
    WORKDIR: NodePath.join(fixture.root, name),
    OUT_DIR: NodePath.join(fixture.root, `${name}-out`),
    ...env,
  });
  const verification = JSON.parse(
    await NodeFSP.readFile(NodePath.join(fixture.root, `${name}-out/VERIFICATION.json`), "utf8"),
  ) as { passed: boolean; checks: ReadonlyArray<{ name: string; passed: boolean }> };
  return { ...result, verification };
};

const home = (fixture: Fixture) => NodePath.join(fixture.root, "work/drill/home");
const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

describe.runIf(hostPlatform === "linux" || hostPlatform === "darwin")("recovery drill", () => {
  it("installs, seeds, updates, writes work, declares failure, recovers, and starts the prior", async () => {
    const fixture = await makeFixture({ priorRecoverFails: false });
    try {
      const result = await drill(fixture);
      expect(result.output).not.toContain("::error::");
      expect(result.code).toBe(0);

      // Each step, by what it asked of t3 and of the admission helpers.
      const steps = result.calls
        .map((call) =>
          call.helper !== undefined
            ? call.helper
            : call.args[0] === "recover" && call.args[1] !== "--help"
              ? `${call.t3} recover <point>`
              : `${call.t3} ${call.args.slice(0, 2).join(" ")}`,
        )
        .filter((step, index, all) => step !== all[index - 1]);
      expect(steps).toEqual([
        `${PRIOR} recover --help`,
        `${PRIOR} --version`,
        `${PRIOR} serve --host`,
        `${PRIOR} auth session`,
        "create-threads.ts",
        "readback.ts",
        "seed.ts",
        `${PRIOR} serve --host`,
        "readback.ts",
        `${PRIOR} update ${TARGET}`,
        `${TARGET} --version`,
        `${TARGET} serve --host`,
        `${TARGET} auth session`,
        "post-upgrade-thread.ts",
        `${TARGET} recover <point>`,
        `${PRIOR} --version`,
        `${PRIOR} serve --host`,
        `${PRIOR} auth session`,
        "readback.ts",
      ]);
      // install.sh, update, and recover get the release URL and tar; serving does not.
      for (const call of result.calls.filter(
        (entry) =>
          entry.args[0] === "update" || (entry.args[0] === "recover" && entry.args[1] !== "--help"),
      )) {
        expect(call.releaseBaseUrl).toBe(fixture.baseUrl);
        expect(call.tar).toBe(true);
      }
      const installCheck = result.calls.find(
        (call) => call.t3 === PRIOR && call.args[0] === "--version",
      );
      expect(installCheck?.releaseBaseUrl).toBe(fixture.baseUrl);
      expect(installCheck?.tar).toBe(true);
      for (const call of result.calls.filter((entry) => entry.args[0] === "serve")) {
        expect(call.releaseBaseUrl).toBeNull();
      }

      const record = JSON.parse(
        await NodeFSP.readFile(NodePath.join(fixture.root, "out/RECOVERY.json"), "utf8"),
      );
      expect(record.actions.map((action: { name: string }) => action.name)).toEqual([
        "install-prior",
        "seed-prior",
        "update",
        "post-upgrade-work",
        "declare-failure",
        "recover",
        "start-prior",
      ]);
      expect(record.prior.version).toBe(PRIOR);
      expect(record.target.version).toBe(TARGET);
      expect(record.database.restoredSha256).toBe(record.database.pointSha256);
      expect(record.recoveryPoint.record.from.version).toBe(PRIOR);
      expect(record.readbacks.restored.environmentId).toBe(record.preUpgradeEnvironmentId);
      expect(record.displacedPath.startsWith(`${record.home.path}/recovery/displaced/`)).toBe(true);
      expect(await NodeFSP.readlink(NodePath.join(fixture.root, "work/drill/bin/t3"))).toBe(
        NodePath.join(home(fixture), "runtime/versions", PRIOR, "t3"),
      );
      // The drilled home keeps the launcher as a symlink.
      const listing = NodeChildProcess.execFileSync(
        "tar",
        ["-tvzf", NodePath.join(fixture.root, "out/drilled-home.tar.gz")],
        { encoding: "utf8" },
      );
      expect(listing).toMatch(/^l.* bin\/t3 -> /m);
      expect(listing).toContain("home/userdata/statev2.sqlite");

      // A fresh verify run re-observes that home and passes the record.
      const verified = await verify(
        fixture,
        NodePath.join(fixture.root, "out/RECOVERY.json"),
        "verify",
      );
      expect(verified.output).not.toContain("::warning::");
      expect(verified.code).toBe(0);
      expect(verified.verification.passed).toBe(true);
      expect(verified.verification.checks.map((check) => check.name)).toEqual([
        "record",
        "recovery-point",
        "restored-database",
        "launcher",
        "prior-binary",
        "fixtures-readback",
        "environment-id",
        "post-upgrade-work",
        "action-order",
        "observations",
      ]);

      // And fails a record whose claims the home does not bear out.
      const forged = NodePath.join(fixture.root, "forged-RECOVERY.json");
      await NodeFSP.writeFile(
        forged,
        JSON.stringify({
          ...record,
          preUpgradeEnvironmentId: "another-environment",
          readbacks: {
            ...record.readbacks,
            restored: { ...record.readbacks.restored, environmentId: "another-environment" },
          },
        }),
      );
      const refuted = await verify(fixture, forged, "verify-forged");
      expect(refuted.code).not.toBe(0);
      expect(
        refuted.verification.checks.filter((check) => !check.passed).map((check) => check.name),
      ).toEqual(["environment-id"]);

      // And fails an observation of its own that did not complete, even when
      // the files it left behind pass.
      const unfinished = await verify(
        fixture,
        NodePath.join(fixture.root, "out/RECOVERY.json"),
        "verify-unfinished",
        { RECOVERY_TEST_READBACK_FAILS: "1" },
      );
      expect(unfinished.output).toContain("::warning::observe_copy did not complete");
      expect(unfinished.code).not.toBe(0);
      expect(unfinished.verification.passed).toBe(false);
      expect(
        unfinished.verification.checks.filter((check) => !check.passed).map((check) => check.name),
      ).toEqual(["observations"]);
      expect(
        JSON.parse(
          await NodeFSP.readFile(
            NodePath.join(fixture.root, "verify-unfinished/readback.json"),
            "utf8",
          ),
        ).passed,
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it("refuses a prior whose t3 recover does not work before anything installs", async () => {
    const fixture = await makeFixture({ priorRecoverFails: true });
    try {
      const result = await drill(fixture);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("`t3 recover --help` failed");
      expect(result.calls.map((call) => call.args.join(" "))).toEqual(["recover --help"]);
      expect(await exists(NodePath.join(home(fixture), "runtime"))).toBe(false);
      expect(await exists(NodePath.join(fixture.root, "work/drill/bin/t3"))).toBe(false);
      expect(await exists(NodePath.join(fixture.root, "out/RECOVERY.json"))).toBe(false);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it.each([
    [
      "the default T3 home",
      async (fixture: Fixture) => {
        await NodeFSP.mkdir(NodePath.join(fixture.root, "user/.t3"), { recursive: true });
        await NodeFSP.mkdir(NodePath.dirname(home(fixture)), { recursive: true });
        await NodeFSP.symlink(NodePath.join(fixture.root, "user/.t3"), home(fixture));
      },
      "refusing to drill the default T3 home",
    ],
    [
      "a home a live server serves",
      async (fixture: Fixture) => {
        await NodeFSP.mkdir(NodePath.join(home(fixture), "userdata"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(home(fixture), "userdata/server-runtime.json"),
          JSON.stringify({ pid: process.pid }),
        );
      },
      `a live server (pid ${process.pid}) serves it`,
    ],
    [
      "a home the t3code service serves",
      async (fixture: Fixture) => {
        const unit = NodePath.join(fixture.root, "user/.config/systemd/user/t3code.service");
        await NodeFSP.mkdir(NodePath.dirname(unit), { recursive: true });
        await NodeFSP.writeFile(unit, `[Service]\nEnvironment=T3CODE_HOME=${home(fixture)}\n`);
      },
      "the t3code service",
    ],
    [
      "a home that is not empty",
      async (fixture: Fixture) => {
        await NodeFSP.mkdir(home(fixture), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(home(fixture), "settings.json"), "{}");
      },
      "it is not empty",
    ],
  ] as const)(
    "refuses %s before anything runs",
    async (_, prepare, message) => {
      const fixture = await makeFixture({ priorRecoverFails: false });
      try {
        await prepare(fixture);
        const result = await drill(fixture);
        expect(result.code).not.toBe(0);
        expect(result.output).toContain(message);
        expect(result.calls).toEqual([]);
        expect(await exists(NodePath.join(fixture.root, "user/.t3/runtime"))).toBe(false);
        expect(await exists(NodePath.join(home(fixture), "runtime"))).toBe(false);
      } finally {
        await fixture.close();
      }
    },
    60_000,
  );
});
