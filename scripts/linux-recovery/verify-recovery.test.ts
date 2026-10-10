// @effect-diagnostics nodeBuiltinImport:off - Builds a drilled home from the committed fixture database.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { drilledRecord, pointSha256, priorSha256, sha } from "./drilled-record.fixture.ts";
import { POST_UPGRADE_THREAD_ID } from "./post-upgrade-thread.ts";
import type { RecoveryRecord } from "./record.ts";
import {
  databaseHasThread,
  listedDigest,
  type RecoveryObservations,
  runVerification,
  verifyRecovery,
} from "./verify-recovery.ts";

const priorT3 = `${drilledRecord.home.path}/runtime/versions/${drilledRecord.prior.version}/t3`;

// What a verify job observes on the home of a drill that recovered.
const recovered: RecoveryObservations = {
  restoredSha256: pointSha256,
  pointSnapshotSha256: pointSha256,
  pointRecord: structuredClone(drilledRecord.recoveryPoint.record),
  launcherTarget: priorT3,
  launcherSha256: sha("f"),
  launcherVersionOutput: `t3 v${drilledRecord.prior.version}\n`,
  priorSums: `${sha("9")}  t3-0.0.46-atli.3-darwin-arm64.tar.gz\n${priorSha256}  ${drilledRecord.prior.archive}\n`,
  priorReleaseT3Sha256: sha("f"),
  readback: { stage: "seeded", passed: true, threads: 3 },
  environmentId: drilledRecord.preUpgradeEnvironmentId,
  displacedHasPostUpgradeThread: true,
  restoredHasPostUpgradeThread: false,
  failedObservations: [],
};

const failedChecks = (record: RecoveryRecord, observations: RecoveryObservations) => {
  const verification = verifyRecovery(record, observations);
  return {
    passed: verification.passed,
    failed: verification.checks.filter((check) => !check.passed).map((check) => check.name),
  };
};

describe("verifyRecovery", () => {
  it("passes a recovery whose every claim it observed", () => {
    const verification = verifyRecovery(drilledRecord, recovered);
    assert.isTrue(verification.passed);
    assert.deepStrictEqual(
      verification.checks.map((check) => check.name),
      [
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
      ],
    );
    assert.isTrue(verification.checks.every((check) => check.passed));
  });

  it.each([
    ["the restored database is not the point's", { restoredSha256: sha("d") }, "restored-database"],
    ["the restored database was not read", { restoredSha256: undefined }, "restored-database"],
    [
      "the point's snapshot changed",
      { pointSnapshotSha256: sha("d") },
      "recovery-point,restored-database",
    ],
    [
      "the point's recovery.json differs",
      {
        pointRecord: {
          ...(drilledRecord.recoveryPoint.record as object),
          to: { version: "0.0.46-atli.5" },
        },
      },
      "recovery-point",
    ],
    [
      "the launcher points at the target",
      { launcherTarget: priorT3.replace("atli.3", "atli.4") },
      "launcher",
    ],
    ["the launcher runs the target", { launcherVersionOutput: "t3 v0.0.46-atli.4" }, "launcher"],
    ["the launcher did not run", { launcherVersionOutput: undefined }, "launcher"],
    ["the launcher's t3 is not the release's", { launcherSha256: sha("e") }, "prior-binary"],
    [
      "SHA256SUMS lists another digest",
      { priorSums: `${sha("e")}  ${drilledRecord.prior.archive}\n` },
      "prior-binary",
    ],
    ["SHA256SUMS was not fetched", { priorSums: undefined }, "prior-binary"],
    ["the release archive was not verified", { priorReleaseT3Sha256: undefined }, "prior-binary"],
    [
      "the fixtures did not read back",
      { readback: { stage: "seeded", passed: false, threads: 3 } },
      "fixtures-readback",
    ],
    [
      "the prior did not start",
      { readback: undefined, environmentId: undefined },
      "fixtures-readback,environment-id",
    ],
    ["the environment id changed", { environmentId: "another-environment" }, "environment-id"],
    [
      "the displaced database lacks the post-upgrade work",
      { displacedHasPostUpgradeThread: false },
      "post-upgrade-work",
    ],
    [
      "the restored database holds the post-upgrade work",
      { restoredHasPostUpgradeThread: true },
      "post-upgrade-work",
    ],
    ["no displaced database", { displacedHasPostUpgradeThread: undefined }, "post-upgrade-work"],
    [
      "an observation did not complete though its files pass",
      { failedObservations: ["observe_copy"] },
      "observations",
    ],
  ] as const)("fails when %s", (_, override, failing) => {
    assert.deepStrictEqual(failedChecks(drilledRecord, { ...recovered, ...override }), {
      passed: false,
      failed: failing.split(","),
    });
  });

  it("fails a record whose actions are out of order or failed", () => {
    const reordered = { ...drilledRecord, actions: drilledRecord.actions.toReversed() };
    assert.deepStrictEqual(failedChecks(reordered, recovered), {
      passed: false,
      failed: ["action-order"],
    });
    const failedRecover = {
      ...drilledRecord,
      actions: drilledRecord.actions.map((action) =>
        action.name === "recover" ? { ...action, exitCode: 1 } : action,
      ),
    };
    assert.deepStrictEqual(failedChecks(failedRecover, recovered).failed, ["action-order"]);
  });

  it("fails an incomplete record", () => {
    assert.deepStrictEqual(
      failedChecks({ ...drilledRecord, preUpgradeEnvironmentId: "" }, recovered).failed,
      ["record", "environment-id"],
    );
  });
});

it("reads the digest SHA256SUMS lists for an archive", () => {
  const sums = `${sha("1")}  t3-a.tar.gz\n${sha("2")} *t3-b.tar.gz\nnot a line\n`;
  assert.strictEqual(listedDigest(sums, "t3-a.tar.gz"), sha("1"));
  assert.strictEqual(listedDigest(sums, "t3-b.tar.gz"), sha("2"));
  assert.strictEqual(listedDigest(sums, "t3-c.tar.gz"), undefined);
});

// pre-upgrade.sqlite is a database a released server wrote (linux-admission).
const fixtureDatabase = NodePath.join(import.meta.dirname, "../linux-admission/pre-upgrade.sqlite");
const fileSha256 = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

const addPostUpgradeThread = (dbPath: string) => {
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database
      .prepare(
        "INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json, application_event_version) VALUES (?, 'thread', ?, 0, 'thread.created', '2026-10-10T10:13:00.000Z', ?, 'user', '{}', '{}', 2)",
      )
      .run(
        `event-${POST_UPGRADE_THREAD_ID}`,
        POST_UPGRADE_THREAD_ID,
        `recovery-drill:thread.create:${POST_UPGRADE_THREAD_ID}`,
      );
  } finally {
    database.close();
  }
};

const scratch = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "recovery-verify-test-"));

describe("databaseHasThread", () => {
  it("finds a thread.created without changing the database", () => {
    const dir = scratch();
    try {
      const dbPath = NodePath.join(dir, "statev2.sqlite");
      NodeFS.copyFileSync(fixtureDatabase, dbPath);
      const before = fileSha256(dbPath);
      assert.isTrue(databaseHasThread(dbPath, "admission-thread-upgrade-notes"));
      assert.isFalse(databaseHasThread(dbPath, POST_UPGRADE_THREAD_ID));
      assert.strictEqual(fileSha256(dbPath), before);
      assert.deepStrictEqual(NodeFS.readdirSync(dir), ["statev2.sqlite"]);
      addPostUpgradeThread(dbPath);
      assert.isTrue(databaseHasThread(dbPath, POST_UPGRADE_THREAD_ID));
      assert.strictEqual(databaseHasThread(NodePath.join(dir, "missing.sqlite"), "x"), undefined);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A drilled home as drilled-home.tar.gz holds it, extracted somewhere other
// than where the drill ran, plus the files run-verify.sh observes.
const makeDrilledHome = (dir: string, options: { readonly restoredDiffers: boolean }) => {
  const recordedHome = "/drill-runner/drill/home";
  const home = NodePath.join(dir, "drilled/home");
  const version = drilledRecord.prior.version;
  const point = drilledRecord.recoveryPoint.id;
  const pointDir = NodePath.join(home, "recovery/points", point);
  const displacedName = `20261010T101300000Z-${point}`;
  const displacedDir = NodePath.join(home, "recovery/displaced", displacedName);
  for (const directory of [
    pointDir,
    displacedDir,
    NodePath.join(home, "userdata"),
    NodePath.join(home, "runtime/versions", version),
    NodePath.join(dir, "drilled/bin"),
    NodePath.join(dir, "release"),
  ]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }
  const snapshot = NodePath.join(pointDir, "statev2.sqlite");
  NodeFS.copyFileSync(fixtureDatabase, snapshot);
  const snapshotSha256 = fileSha256(snapshot);
  const live = NodePath.join(home, "userdata/statev2.sqlite");
  NodeFS.copyFileSync(fixtureDatabase, live);
  if (options.restoredDiffers) addPostUpgradeThread(live);
  NodeFS.copyFileSync(fixtureDatabase, NodePath.join(displacedDir, "statev2.sqlite"));
  addPostUpgradeThread(NodePath.join(displacedDir, "statev2.sqlite"));

  const pointRecord = {
    ...(drilledRecord.recoveryPoint.record as Record<string, unknown>),
    snapshot: { size: NodeFS.statSync(snapshot).size, sha256: snapshotSha256 },
  };
  NodeFS.writeFileSync(
    NodePath.join(pointDir, "recovery.json"),
    JSON.stringify(pointRecord, null, 2),
  );
  const t3 = "#!/bin/sh\necho 't3 v0.0.46-atli.3'\n";
  NodeFS.writeFileSync(NodePath.join(home, "runtime/versions", version, "t3"), t3, { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(dir, "release/t3"), t3, { mode: 0o755 });
  // The launcher keeps the drill's absolute target, as the tarball does.
  NodeFS.symlinkSync(
    `${recordedHome}/runtime/versions/${version}/t3`,
    NodePath.join(dir, "drilled/bin/t3"),
  );

  const record: RecoveryRecord = {
    ...drilledRecord,
    recoveryPoint: { id: point, record: pointRecord },
    database: { pointSha256: snapshotSha256, restoredSha256: snapshotSha256 },
    home: { path: recordedHome, launcher: "/drill-runner/drill/bin/t3" },
    displacedPath: `${recordedHome}/recovery/displaced/${displacedName}`,
  };
  const write = (name: string, contents: string) => {
    NodeFS.writeFileSync(NodePath.join(dir, name), contents);
    return NodePath.join(dir, name);
  };
  return {
    record: write("RECOVERY.json", JSON.stringify(record, null, 2)),
    home,
    launcher: NodePath.join(dir, "drilled/bin/t3"),
    launcherVersion: write("launcher-version.txt", `t3 v${version}\n`),
    priorSums: write("SHA256SUMS", `${priorSha256}  ${drilledRecord.prior.archive}\n`),
    priorReleaseT3: NodePath.join(dir, "release/t3"),
    readback: write(
      "readback.json",
      JSON.stringify({
        stage: "seeded",
        passed: true,
        threads: 3,
        messages: 7,
        events: 0,
        items: [],
      }),
    ),
    environment: write(
      "environment.json",
      JSON.stringify({
        environmentId: drilledRecord.preUpgradeEnvironmentId,
        serverVersion: version,
      }),
    ),
    failedObservations: "",
    out: NodePath.join(dir, "out"),
  };
};

const readVerification = (out: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(out, "VERIFICATION.json"), "utf8")) as {
    passed: boolean;
    checks: ReadonlyArray<{ name: string; passed: boolean; detail: string }>;
  };

describe("runVerification", () => {
  it.effect("re-observes an uploaded home at another path and passes it", () =>
    Effect.gen(function* () {
      const dir = scratch();
      try {
        const files = makeDrilledHome(dir, { restoredDiffers: false });
        yield* runVerification(files);
        const verification = readVerification(files.out);
        assert.isTrue(verification.passed);
        assert.isTrue(verification.checks.every((check) => check.passed));
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("writes the failed checks and fails when the live database is not the point's", () =>
    Effect.gen(function* () {
      const dir = scratch();
      try {
        const files = makeDrilledHome(dir, { restoredDiffers: true });
        const error = yield* Effect.flip(runVerification(files));
        assert.strictEqual(error._tag, "RecoveryVerificationFailedError");
        const verification = readVerification(files.out);
        assert.isFalse(verification.passed);
        assert.deepStrictEqual(
          verification.checks.filter((check) => !check.passed).map((check) => check.name),
          ["restored-database", "post-upgrade-work"],
        );
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when an observation did not complete, whatever files it left", () =>
    Effect.gen(function* () {
      const dir = scratch();
      try {
        const files = makeDrilledHome(dir, { restoredDiffers: false });
        yield* Effect.flip(
          runVerification({ ...files, failedObservations: "observe_launcher,observe_copy" }),
        );
        const verification = readVerification(files.out);
        assert.isFalse(verification.passed);
        assert.deepStrictEqual(
          verification.checks.filter((check) => !check.passed),
          [
            {
              name: "observations",
              passed: false,
              detail: "observe_launcher, observe_copy did not complete",
            },
          ],
        );
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails a record it cannot read", () =>
    Effect.gen(function* () {
      const dir = scratch();
      try {
        const files = makeDrilledHome(dir, { restoredDiffers: false });
        NodeFS.writeFileSync(files.record, "{}");
        yield* Effect.flip(runVerification(files));
        assert.deepStrictEqual(
          readVerification(files.out).checks.map((check) => [check.name, check.passed]),
          [["record", false]],
        );
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
