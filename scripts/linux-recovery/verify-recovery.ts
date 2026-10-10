#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Effect has no SQLite client; a copied database is read with node:sqlite.

// Fork-only (atlitech/t3code). The recovery drill's independent verdict
// (run-verify.sh): on a fresh runner, everything RECOVERY.json claims is
// checked against what this job observes itself on the uploaded drilled
// home. The live database must hash to the recovery point's snapshot, the
// launcher must run the prior and be the `t3` from the prior's verified
// release archive, the prior started on a copy of the home must read the
// fixtures back and report the pre-upgrade environment id, and the database
// recover moved aside must hold the post-upgrade thread the restored one
// lacks. VERIFICATION.json lists every check; any failed check fails the job.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { POST_UPGRADE_THREAD_ID } from "./post-upgrade-thread.ts";
import {
  actionProblems,
  decodeRecoveryRecordJson,
  type RecoveryRecord,
  recordProblems,
} from "./record.ts";

export const VERIFICATION_FILE = "VERIFICATION.json";

export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface Verification {
  readonly passed: boolean;
  readonly checks: ReadonlyArray<VerificationCheck>;
}

/** What the verify job observed itself; undefined is what it could not observe. */
export interface RecoveryObservations {
  /** sha256 of the drilled home's live database. */
  readonly restoredSha256: string | undefined;
  /** sha256 of the recovery point's snapshot in the drilled home. */
  readonly pointSnapshotSha256: string | undefined;
  /** The recovery point's recovery.json in the drilled home. */
  readonly pointRecord: unknown;
  /** Where the drilled home's `t3` launcher points. */
  readonly launcherTarget: string | undefined;
  /** sha256 of the file the launcher points at, inside the drilled home. */
  readonly launcherSha256: string | undefined;
  /** What the launcher's `t3 --version` printed. */
  readonly launcherVersionOutput: string | undefined;
  /** The prior release's SHA256SUMS, fetched by this job. */
  readonly priorSums: string | undefined;
  /** sha256 of the `t3` in the prior's archive, verified against priorSums by this job. */
  readonly priorReleaseT3Sha256: string | undefined;
  /** readback.ts's result from the prior started on a copy of the drilled home. */
  readonly readback:
    | { readonly stage: string; readonly passed: boolean; readonly threads: number }
    | undefined;
  /** The environment id the prior reported on that copy. */
  readonly environmentId: string | undefined;
  readonly displacedHasPostUpgradeThread: boolean | undefined;
  readonly restoredHasPostUpgradeThread: boolean | undefined;
}

const observed = <A>(value: A | undefined, render: (value: A) => string = String) =>
  value === undefined ? "not observed" : render(value);

/** The digest SHA256SUMS lists for `archive`, if it lists one. */
export const listedDigest = (sums: string, archive: string): string | undefined => {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[2] === archive) return match[1];
  }
  return undefined;
};

const versionPrinted = (output: string | undefined) =>
  output === undefined ? undefined : /\bv(\S+)\s*$/.exec(output.trim())?.[1];

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

const check = (name: string, passed: boolean, detail: string): VerificationCheck => ({
  name,
  passed,
  detail,
});

/** Judges a recovery record by the verify job's own observations. */
export const verifyRecovery = (
  record: RecoveryRecord,
  observations: RecoveryObservations,
): Verification => {
  const point = record.database.pointSha256;
  const recordFaults = recordProblems(record);
  const actionFaults = actionProblems(record.actions);
  const expectedLauncher = `${record.home.path.replace(/\/+$/, "")}/runtime/versions/${record.prior.version}/t3`;
  const printed = versionPrinted(observations.launcherVersionOutput);
  const listed =
    observations.priorSums === undefined
      ? undefined
      : listedDigest(observations.priorSums, record.prior.archive);
  const pointRecordMatches =
    observations.pointRecord !== undefined &&
    canonicalJson(observations.pointRecord) === canonicalJson(record.recoveryPoint.record);
  const { readback } = observations;
  const checks = [
    check(
      "record",
      recordFaults.length === 0,
      recordFaults.length === 0 ? "complete" : recordFaults.join("; "),
    ),
    check(
      "recovery-point",
      pointRecordMatches && observations.pointSnapshotSha256 === point,
      `recovery point ${record.recoveryPoint.id}: recovery.json ${
        observations.pointRecord === undefined
          ? "not observed"
          : pointRecordMatches
            ? "is the recorded one"
            : "differs from the recorded one"
      }; snapshot sha256 ${observed(observations.pointSnapshotSha256)}, recorded ${point}`,
    ),
    check(
      "restored-database",
      observations.restoredSha256 !== undefined &&
        observations.restoredSha256 === point &&
        observations.restoredSha256 === observations.pointSnapshotSha256,
      `live database sha256 ${observed(observations.restoredSha256)}; the point's snapshot is ${observed(observations.pointSnapshotSha256)} (recorded ${point})`,
    ),
    check(
      "launcher",
      observations.launcherTarget === expectedLauncher && printed === record.prior.version,
      `the launcher points at ${observed(observations.launcherTarget)} (expected ${expectedLauncher}) and reports ${observed(printed)} (expected ${record.prior.version})`,
    ),
    check(
      "prior-binary",
      listed !== undefined &&
        listed === record.prior.archiveSha256 &&
        observations.launcherSha256 !== undefined &&
        observations.launcherSha256 === observations.priorReleaseT3Sha256,
      `v${record.prior.version}'s SHA256SUMS lists ${record.prior.archive} as ${observed(listed)} (recorded ${record.prior.archiveSha256}); the launcher's t3 hashes to ${observed(observations.launcherSha256)}, the archive's t3 to ${observed(observations.priorReleaseT3Sha256)}`,
    ),
    check(
      "fixtures-readback",
      readback !== undefined &&
        readback.stage === "seeded" &&
        readback.passed &&
        readback.threads > 0,
      readback === undefined
        ? "the prior did not read the fixtures back on a copy of the home"
        : `the prior read back ${readback.threads} fixture threads at the ${readback.stage} stage (${readback.passed ? "passed" : "failed"})`,
    ),
    check(
      "environment-id",
      observations.environmentId !== undefined &&
        observations.environmentId.length > 0 &&
        observations.environmentId === record.preUpgradeEnvironmentId,
      `the prior reports environment ${observed(observations.environmentId)}; before the upgrade it was ${record.preUpgradeEnvironmentId}`,
    ),
    check(
      "post-upgrade-work",
      observations.displacedHasPostUpgradeThread === true &&
        observations.restoredHasPostUpgradeThread === false,
      `${POST_UPGRADE_THREAD_ID}: in the displaced database ${observed(observations.displacedHasPostUpgradeThread)}, in the restored database ${observed(observations.restoredHasPostUpgradeThread)}`,
    ),
    check(
      "action-order",
      actionFaults.length === 0,
      actionFaults.length === 0
        ? record.actions.map((action) => action.name).join(" -> ")
        : actionFaults.join("; "),
    ),
  ];
  return { passed: checks.every((entry) => entry.passed), checks };
};

export class RecoveryVerificationFailedError extends Schema.TaggedError<RecoveryVerificationFailedError>()(
  "RecoveryVerificationFailedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `The recovery did not verify: ${this.detail}`;
  }
}

/**
 * Whether the database at `dbPath` holds `threadId`'s thread.created. It reads
 * a private copy, so neither the database nor its journal is ever touched;
 * undefined when there is no database or it cannot be read.
 */
export const databaseHasThread = (dbPath: string, threadId: string): boolean | undefined => {
  if (!NodeFS.existsSync(dbPath)) return undefined;
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "recovery-verify-"));
  try {
    const copy = NodePath.join(dir, "statev2.sqlite");
    for (const suffix of ["", "-wal"]) {
      if (NodeFS.existsSync(`${dbPath}${suffix}`)) {
        NodeFS.copyFileSync(`${dbPath}${suffix}`, `${copy}${suffix}`);
      }
    }
    const database = new NodeSqlite.DatabaseSync(copy);
    try {
      const row = database
        .prepare(
          "SELECT count(*) AS count FROM orchestration_events WHERE aggregate_kind = 'thread' AND event_type = 'thread.created' AND stream_id = ?",
        )
        .get(threadId);
      return Number(row?.["count"] ?? 0) > 0;
    } finally {
      database.close();
    }
  } catch {
    return undefined;
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const encodeVerification = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown, { space: 2 }),
);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeReadback = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ stage: Schema.String, passed: Schema.Boolean, threads: Schema.Number }),
  ),
);
const decodeEnvironment = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ environmentId: Schema.String })),
);

export const runVerification = Effect.fn("runVerification")(function* (options: {
  readonly record: string;
  readonly home: string;
  readonly launcher: string;
  readonly launcherVersion: string;
  readonly priorSums: string;
  readonly priorReleaseT3: string;
  readonly readback: string;
  readonly environment: string;
  readonly out: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.option, Effect.map(Option.getOrUndefined));
  const sha256 = (file: string) =>
    attempt(
      Effect.map(
        Effect.flatMap(fs.readFile(file), (bytes) => crypto.digest("SHA-256", bytes)),
        toHex,
      ),
    );
  const text = (file: string) => attempt(fs.readFileString(file));
  const write = (verification: Verification) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(options.out, { recursive: true });
      const json = yield* encodeVerification(verification);
      yield* fs.writeFileString(path.join(options.out, VERIFICATION_FILE), `${json}\n`);
      yield* Effect.log(json);
      const failed = verification.checks.filter((entry) => !entry.passed);
      if (failed.length > 0) {
        return yield* new RecoveryVerificationFailedError({
          detail: failed.map((entry) => `${entry.name}: ${entry.detail}`).join("\n"),
        });
      }
    });

  const decoded = yield* Effect.result(
    Effect.flatMap(fs.readFileString(options.record), decodeRecoveryRecordJson),
  );
  if (decoded._tag === "Failure") {
    return yield* write({
      passed: false,
      checks: [
        check("record", false, `${options.record} is not a recovery record: ${decoded.failure}`),
      ],
    });
  }
  const record = decoded.success;
  // The drill's absolute paths, re-rooted at the uploaded home.
  const recordedHome = record.home.path.replace(/\/+$/, "");
  const inHome = (recorded: string) =>
    recorded === recordedHome || recorded.startsWith(`${recordedHome}/`)
      ? path.join(options.home, recorded.slice(recordedHome.length))
      : undefined;

  const pointDir = path.join(options.home, "recovery", "points", record.recoveryPoint.id);
  const liveDb = path.join(options.home, "userdata", "statev2.sqlite");
  // Hashed before anything opens it.
  const restoredSha256 = yield* sha256(liveDb);
  const pointSnapshotSha256 = yield* sha256(path.join(pointDir, "statev2.sqlite"));
  const pointRecordText = yield* text(path.join(pointDir, "recovery.json"));
  const pointRecord =
    pointRecordText === undefined ? undefined : yield* attempt(decodeJson(pointRecordText));
  const launcherTarget = yield* attempt(fs.readLink(options.launcher));
  const launcherFile = launcherTarget === undefined ? undefined : inHome(launcherTarget);
  const displacedDir = inHome(record.displacedPath);
  const readbackText = yield* text(options.readback);
  const environmentText = yield* text(options.environment);

  return yield* write(
    verifyRecovery(record, {
      restoredSha256,
      pointSnapshotSha256,
      pointRecord,
      launcherTarget,
      launcherSha256: launcherFile === undefined ? undefined : yield* sha256(launcherFile),
      launcherVersionOutput: yield* text(options.launcherVersion),
      priorSums: yield* text(options.priorSums),
      priorReleaseT3Sha256: yield* sha256(options.priorReleaseT3),
      readback:
        readbackText === undefined ? undefined : yield* attempt(decodeReadback(readbackText)),
      environmentId:
        environmentText === undefined
          ? undefined
          : (yield* attempt(decodeEnvironment(environmentText)))?.environmentId,
      displacedHasPostUpgradeThread:
        displacedDir === undefined
          ? undefined
          : databaseHasThread(path.join(displacedDir, "statev2.sqlite"), POST_UPGRADE_THREAD_ID),
      restoredHasPostUpgradeThread: databaseHasThread(liveDb, POST_UPGRADE_THREAD_ID),
    }),
  );
});

const file = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description));

const command = Command.make(
  "linux-recovery-verify",
  {
    record: file("record", "The drill's RECOVERY.json."),
    home: file("home", "The drilled T3 home, extracted from drilled-home.tar.gz."),
    launcher: file("launcher", "The drilled `t3` launcher, extracted beside the home."),
    launcherVersion: file("launcher-version", "What the launcher's `t3 --version` printed."),
    priorSums: file("prior-sums", "The prior release's SHA256SUMS, fetched by this job."),
    priorReleaseT3: file(
      "prior-release-t3",
      "The `t3` extracted from the prior's archive, verified against prior-sums.",
    ),
    readback: file("readback", "readback.ts's `seeded` result from the prior on a copy."),
    environment: file(
      "environment",
      "GET /.well-known/t3/environment from the prior on that copy.",
    ),
    out: file("out", "Directory to write VERIFICATION.json into."),
  },
  (options) => runVerification(options),
).pipe(Command.withDescription("Verify a recovery drill's record against the drilled home."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
