#!/usr/bin/env node

// Fork-only (atlitech/t3code). Writes RECOVERY.json, the recovery drill's
// record (run-drill.sh): which admitted release a scratch T3 home upgraded
// from and to, the recovery point `t3 update` kept, the database at that
// point and right after `t3 recover`, the pre-upgrade environment id, what
// the prior read back, and every operator action in order. A record missing
// any of it, or describing a recovery that did not restore the point, is
// refused and nothing is written. The verify job re-observes the drilled
// home against it (verify-recovery.ts).

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { compareVersions, isForkVersion } from "../linux-admission/prior-release.ts";

export const RECOVERY_FILE = "RECOVERY.json";

/** Every operator action a drill takes, in the order it takes them. */
export const DRILL_ACTIONS = [
  "install-prior",
  "seed-prior",
  "update",
  "post-upgrade-work",
  "declare-failure",
  "recover",
  "start-prior",
] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const Release = Schema.Struct({
  version: Schema.String,
  archive: Schema.String,
  archiveSha256: Schema.String,
});

const ReadbackSummary = Schema.Struct({
  stage: Schema.Literals(["created", "seeded", "upgraded"]),
  passed: Schema.Boolean,
  threads: Schema.Number,
  messages: Schema.Number,
});

const Action = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  startedAt: Schema.String,
  endedAt: Schema.String,
  exitCode: Schema.Number,
});
export type DrillAction = typeof Action.Type;

export const RecoveryRecord = Schema.Struct({
  drillId: Schema.String,
  commit: Schema.String,
  host: Schema.String,
  prior: Release,
  target: Release,
  recoveryPoint: Schema.Struct({
    id: Schema.String,
    /** The point's recovery.json, as `t3 update` wrote it. */
    record: Schema.Unknown,
  }),
  database: Schema.Struct({ pointSha256: Schema.String, restoredSha256: Schema.String }),
  preUpgradeEnvironmentId: Schema.String,
  /** Where the drill's T3 home and its `t3` launcher lived on the drill's runner. */
  home: Schema.Struct({ path: Schema.String, launcher: Schema.String }),
  displacedPath: Schema.String,
  readbacks: Schema.Struct({
    prior: ReadbackSummary,
    restored: Schema.Struct({ ...ReadbackSummary.fields, environmentId: Schema.String }),
  }),
  actions: Schema.Array(Action),
});
export type RecoveryRecord = typeof RecoveryRecord.Type;

const RecoveryRecordJson = Schema.fromJsonString(RecoveryRecord, { space: 2 });
const encodeRecordJson = Schema.encodeEffect(RecoveryRecordJson);
export const decodeRecoveryRecordJson = Schema.decodeUnknownEffect(RecoveryRecordJson);

// The fields of a point's recovery.json (apps/server cloud/recoveryPoint.ts)
// the record is checked against; the rest is kept verbatim.
const PointRecord = Schema.Struct({
  id: Schema.String,
  from: Schema.Struct({ version: Schema.String, archiveSha256: Schema.NullOr(Schema.String) }),
  to: Schema.Struct({ version: Schema.String }),
  snapshot: Schema.Struct({ sha256: Schema.String }),
});
const decodePointRecord = Schema.decodeUnknownOption(PointRecord);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const releaseProblems = (role: string, release: typeof Release.Type): Array<string> => {
  const problems: Array<string> = [];
  if (!isForkVersion(release.version)) {
    problems.push(`the ${role} version '${release.version}' is not a fork version`);
  }
  if (
    !new RegExp(`^t3-${escapeRegExp(release.version)}-[a-z0-9]+-[a-z0-9]+\\.tar\\.gz$`).test(
      release.archive,
    )
  ) {
    problems.push(
      `the ${role} archive '${release.archive}' is not a t3-${release.version} archive`,
    );
  }
  if (!SHA256_PATTERN.test(release.archiveSha256)) {
    problems.push(`the ${role} archive sha256 is not a sha256`);
  }
  return problems;
};

/** Why `actions` is not every drill action, in order, each finished with exit code 0. */
export const actionProblems = (actions: ReadonlyArray<DrillAction>): Array<string> => {
  const problems: Array<string> = [];
  const names = actions.map((action) => action.name);
  if (names.join(",") !== DRILL_ACTIONS.join(",")) {
    problems.push(`the actions are [${names.join(", ")}], not [${DRILL_ACTIONS.join(", ")}]`);
  }
  actions.forEach((action, index) => {
    if (action.command.trim().length === 0) problems.push(`${action.name} names no command`);
    if (!UTC_PATTERN.test(action.startedAt) || !UTC_PATTERN.test(action.endedAt)) {
      problems.push(`${action.name}'s times are not ISO-8601 UTC`);
    } else if (Date.parse(action.endedAt) < Date.parse(action.startedAt)) {
      problems.push(`${action.name} ended before it started`);
    }
    const next = actions[index + 1];
    if (
      next !== undefined &&
      UTC_PATTERN.test(next.startedAt) &&
      UTC_PATTERN.test(action.endedAt) &&
      Date.parse(next.startedAt) < Date.parse(action.endedAt)
    ) {
      problems.push(`${next.name} started before ${action.name} ended`);
    }
    if (action.exitCode !== 0) problems.push(`${action.name} exited ${action.exitCode}`);
  });
  return problems;
};

/**
 * Why the record, apart from its actions, is not a complete account of a
 * recovery that put the point's database back.
 */
export const recordProblems = (record: RecoveryRecord): Array<string> => {
  const problems: Array<string> = [];
  const required = {
    drillId: record.drillId,
    host: record.host,
    "recoveryPoint.id": record.recoveryPoint.id,
    preUpgradeEnvironmentId: record.preUpgradeEnvironmentId,
    "home.path": record.home.path,
    "home.launcher": record.home.launcher,
    displacedPath: record.displacedPath,
  };
  for (const [field, value] of Object.entries(required)) {
    if (value.trim().length === 0) problems.push(`${field} is empty`);
  }
  if (!COMMIT_PATTERN.test(record.commit)) {
    problems.push(`the commit must be a full SHA; got '${record.commit}'`);
  }
  problems.push(
    ...releaseProblems("prior", record.prior),
    ...releaseProblems("target", record.target),
  );
  if (
    isForkVersion(record.prior.version) &&
    isForkVersion(record.target.version) &&
    compareVersions(record.prior.version, record.target.version) >= 0
  ) {
    problems.push(`the prior ${record.prior.version} is not earlier than ${record.target.version}`);
  }
  const { pointSha256, restoredSha256 } = record.database;
  if (!SHA256_PATTERN.test(pointSha256) || !SHA256_PATTERN.test(restoredSha256)) {
    problems.push("a database sha256 is not a sha256");
  } else if (restoredSha256 !== pointSha256) {
    problems.push(
      `the restored database's sha256 ${restoredSha256} is not the point's ${pointSha256}`,
    );
  }
  Option.match(decodePointRecord(record.recoveryPoint.record), {
    onNone: () => problems.push("the recovery point's recovery.json is not a point record"),
    onSome: (point) => {
      if (point.id !== record.recoveryPoint.id) {
        problems.push(`the point's recovery.json is for '${point.id}'`);
      }
      if (
        point.from.version !== record.prior.version ||
        point.to.version !== record.target.version
      ) {
        problems.push(
          `the point is from ${point.from.version} to ${point.to.version}, not ${record.prior.version} to ${record.target.version}`,
        );
      }
      if (point.from.archiveSha256 !== record.prior.archiveSha256) {
        problems.push(
          `the point records the prior archive sha256 ${point.from.archiveSha256}, not ${record.prior.archiveSha256}`,
        );
      }
      if (point.snapshot.sha256 !== pointSha256) {
        problems.push(
          `the point's recovery.json records snapshot sha256 ${point.snapshot.sha256}, the snapshot hashes to ${pointSha256}`,
        );
      }
    },
  });
  const home = record.home.path.replace(/\/+$/, "");
  if (!record.displacedPath.startsWith(`${home}/recovery/displaced/`)) {
    problems.push(
      `the displaced path ${record.displacedPath} is not in ${home}/recovery/displaced`,
    );
  }
  for (const [role, readback] of Object.entries(record.readbacks)) {
    if (readback.stage !== "seeded" || !readback.passed || readback.threads === 0) {
      problems.push(`the ${role} readback did not read the seeded fixtures back`);
    }
  }
  if (record.readbacks.restored.environmentId !== record.preUpgradeEnvironmentId) {
    problems.push(
      `the restored home's environment id '${record.readbacks.restored.environmentId}' is not the pre-upgrade '${record.preUpgradeEnvironmentId}'`,
    );
  }
  return problems;
};

export class RecoveryRecordRefusedError extends Schema.TaggedError<RecoveryRecordRefusedError>()(
  "RecoveryRecordRefusedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `No recovery record: ${this.detail}`;
  }
}

/**
 * The record of a drill whose installed runtimes came from the recorded
 * archives (`installedArchiveSha256`, each runtime's .archive-sha256), or a
 * refusal naming everything it lacks.
 */
export const buildRecoveryRecord = (
  input: RecoveryRecord & {
    readonly installedArchiveSha256: { readonly prior: string; readonly target: string };
  },
) =>
  Effect.gen(function* () {
    const { installedArchiveSha256, ...record } = input;
    const problems = [...recordProblems(record), ...actionProblems(record.actions)];
    for (const role of ["prior", "target"] as const) {
      if (installedArchiveSha256[role] !== record[role].archiveSha256) {
        problems.push(
          `the installed ${role} runtime came from an archive with sha256 '${installedArchiveSha256[role]}', not ${record[role].archive}`,
        );
      }
    }
    if (problems.length > 0) {
      return yield* new RecoveryRecordRefusedError({ detail: `${problems.join("; ")}.` });
    }
    const json = yield* encodeRecordJson(record).pipe(
      Effect.mapError(
        () => new RecoveryRecordRefusedError({ detail: "the record does not encode." }),
      ),
    );
    return { record, json: `${json}\n` };
  });

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const decodeReadback = Schema.decodeEffect(Schema.fromJsonString(ReadbackSummary));
const decodeEnvironment = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ environmentId: Schema.String })),
);
const decodeAction = Schema.decodeEffect(Schema.fromJsonString(Action));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export const writeRecoveryRecord = Effect.fn("writeRecoveryRecord")(function* (options: {
  readonly drillId: string;
  readonly commit: string;
  readonly host: string;
  readonly priorVersion: string;
  readonly priorArchive: string;
  readonly targetVersion: string;
  readonly targetArchive: string;
  readonly home: string;
  readonly launcher: string;
  readonly pointId: string;
  readonly restoredSha256: string;
  readonly preUpgradeEnvironmentId: string;
  readonly displacedPath: string;
  readonly priorReadback: string;
  readonly restoredReadback: string;
  readonly restoredEnvironment: string;
  readonly actions: string;
  readonly out: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sha256 = (file: string) =>
    Effect.map(
      Effect.flatMap(fs.readFile(file), (bytes) => crypto.digest("SHA-256", bytes)),
      toHex,
    );
  const installed = (version: string) =>
    fs
      .readFileString(path.join(options.home, "runtime", "versions", version, ".archive-sha256"))
      .pipe(Effect.map((text) => text.trim()));
  const pointDir = path.join(options.home, "recovery", "points", options.pointId);
  const actions = yield* Effect.forEach(
    (yield* fs.readFileString(options.actions)).split("\n").filter((line) => line.trim() !== ""),
    (line) => decodeAction(line),
  );
  const restoredReadback = yield* decodeReadback(
    yield* fs.readFileString(options.restoredReadback),
  );
  const { environmentId } = yield* decodeEnvironment(
    yield* fs.readFileString(options.restoredEnvironment),
  );
  const built = yield* buildRecoveryRecord({
    drillId: options.drillId,
    commit: options.commit,
    host: options.host,
    prior: {
      version: options.priorVersion,
      archive: path.basename(options.priorArchive),
      archiveSha256: yield* sha256(options.priorArchive),
    },
    target: {
      version: options.targetVersion,
      archive: path.basename(options.targetArchive),
      archiveSha256: yield* sha256(options.targetArchive),
    },
    recoveryPoint: {
      id: options.pointId,
      record: yield* decodeJson(yield* fs.readFileString(path.join(pointDir, "recovery.json"))),
    },
    database: {
      pointSha256: yield* sha256(path.join(pointDir, "statev2.sqlite")),
      restoredSha256: options.restoredSha256,
    },
    preUpgradeEnvironmentId: options.preUpgradeEnvironmentId,
    home: { path: options.home, launcher: options.launcher },
    displacedPath: options.displacedPath,
    readbacks: {
      prior: yield* decodeReadback(yield* fs.readFileString(options.priorReadback)),
      restored: { ...restoredReadback, environmentId },
    },
    actions,
    installedArchiveSha256: {
      prior: yield* installed(options.priorVersion),
      target: yield* installed(options.targetVersion),
    },
  });
  yield* fs.makeDirectory(options.out, { recursive: true });
  yield* fs.writeFileString(path.join(options.out, RECOVERY_FILE), built.json);
  yield* Effect.log(built.json.trimEnd());
});

const file = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description));

const command = Command.make(
  "linux-recovery-record",
  {
    drillId: file("drill-id", "This drill's id."),
    commit: file("commit", "The commit whose drill scripts ran."),
    host: file("host", "The machine the drill ran on."),
    priorVersion: file("prior-version", "The admitted version the home upgraded from."),
    priorArchive: file("prior-archive", "The prior's release archive, verified by SHA256SUMS."),
    targetVersion: file("target-version", "The admitted version the home upgraded to."),
    targetArchive: file("target-archive", "The target's release archive, verified by SHA256SUMS."),
    home: file("home", "The drilled T3 home."),
    launcher: file("launcher", "The `t3` launcher the installer wrote."),
    pointId: file("point-id", "The recovery point `t3 update` kept."),
    restoredSha256: file("restored-sha256", "The live database's sha256 right after recover."),
    preUpgradeEnvironmentId: file(
      "pre-upgrade-environment-id",
      "The home's environment id before the upgrade.",
    ),
    displacedPath: file("displaced-path", "Where recover moved the upgraded database."),
    priorReadback: file("prior-readback", "readback.ts's `seeded` result, from the prior."),
    restoredReadback: file(
      "restored-readback",
      "readback.ts's `seeded` result, from the prior on the restored home.",
    ),
    restoredEnvironment: file(
      "restored-environment",
      "GET /.well-known/t3/environment, from the prior on the restored home.",
    ),
    actions: file("actions", "The operator actions, one JSON object per line."),
    out: file("out", "Directory to write RECOVERY.json into."),
  },
  (options) => writeRecoveryRecord(options),
).pipe(Command.withDescription("Write RECOVERY.json only for a complete recovery drill."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
