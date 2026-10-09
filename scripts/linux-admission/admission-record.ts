#!/usr/bin/env node

// Fork-only (atlitech/t3code). Writes ADMISSION.json, the record that a Linux
// archive passed its admission: the release publishes it, attested, beside
// the archive, and the next release's admission upgrades from it. It is
// written only when the archive is the one the build made and every check
// passed; otherwise nothing is written.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { ADMISSION_FILE, isForkVersion, type PriorReleaseSource } from "./prior-release.ts";
import type { AdmissionCheck } from "./probe.ts";

/** Every check an admission runs; a record missing one is refused. */
export const REQUIRED_CHECKS = [
  "archive-digest",
  "prior-readback",
  "root",
  "environment-version",
  "readback",
  "event-log",
];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const AdmissionRecord = Schema.Struct({
  version: Schema.String,
  archive: Schema.String,
  archiveSha256: Schema.String,
  priorVersion: Schema.String,
  priorSource: Schema.Literals(["admitted", "bootstrap"]),
  verifierCommit: Schema.String,
  checks: Schema.Array(
    Schema.Struct({ name: Schema.String, passed: Schema.Boolean, detail: Schema.String }),
  ),
});
export type AdmissionRecord = typeof AdmissionRecord.Type;

const encodeRecordJson = Schema.encodeEffect(Schema.fromJsonString(AdmissionRecord, { space: 2 }));

export class AdmissionRefusedError extends Schema.TaggedError<AdmissionRefusedError>()(
  "AdmissionRefusedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Not admitted: ${this.detail}`;
  }
}

/** The archive-digest check: the archive under test is the one the build made. */
export const archiveDigestCheck = (actual: string, expected: string): AdmissionCheck => ({
  name: "archive-digest",
  passed: SHA256_PATTERN.test(expected) && actual === expected,
  detail: `sha256 ${actual}, build reported ${expected}`,
});

export const buildAdmissionRecord = (input: {
  readonly version: string;
  readonly archiveSha256: string;
  readonly expectedSha256: string;
  readonly priorVersion: string;
  readonly priorSource: PriorReleaseSource;
  readonly verifierCommit: string;
  readonly checks: ReadonlyArray<AdmissionCheck>;
}) =>
  Effect.gen(function* () {
    const refuse = (detail: string) => Effect.fail(new AdmissionRefusedError({ detail }));
    if (!isForkVersion(input.version)) {
      return yield* refuse(`'${input.version}' is not a fork version.`);
    }
    if (!isForkVersion(input.priorVersion) || input.priorVersion === input.version) {
      return yield* refuse(`'${input.priorVersion}' is not an earlier fork version.`);
    }
    if (!SHA256_PATTERN.test(input.archiveSha256) || !SHA256_PATTERN.test(input.expectedSha256)) {
      return yield* refuse("the archive digest is not a sha256.");
    }
    if (input.archiveSha256 !== input.expectedSha256) {
      return yield* refuse(
        `the archive's sha256 ${input.archiveSha256} is not the build's ${input.expectedSha256}.`,
      );
    }
    if (!COMMIT_PATTERN.test(input.verifierCommit)) {
      return yield* refuse(
        `the verifier commit must be a full SHA; got '${input.verifierCommit}'.`,
      );
    }
    const names = input.checks.map((check) => check.name);
    const missing = REQUIRED_CHECKS.filter((name) => !names.includes(name));
    if (missing.length > 0) return yield* refuse(`missing checks: ${missing.join(", ")}.`);
    if (new Set(names).size !== names.length) return yield* refuse("a check is repeated.");
    const failed = input.checks.filter((check) => !check.passed);
    if (failed.length > 0) {
      return yield* refuse(
        `failed checks: ${failed.map((check) => `${check.name} (${check.detail})`).join("; ")}.`,
      );
    }
    const record: AdmissionRecord = {
      version: input.version,
      archive: `t3-${input.version}-linux-x64.tar.gz`,
      archiveSha256: input.archiveSha256,
      priorVersion: input.priorVersion,
      priorSource: input.priorSource,
      verifierCommit: input.verifierCommit,
      checks: input.checks.map(({ name, passed, detail }) => ({ name, passed, detail })),
    };
    const json = yield* encodeRecordJson(record).pipe(
      Effect.mapError(() => new AdmissionRefusedError({ detail: "the record does not encode." })),
    );
    return { record, json: `${json}\n` };
  });

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const ProbeChecks = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ name: Schema.String, passed: Schema.Boolean, detail: Schema.String }),
  ),
);
const ReadbackSummary = Schema.fromJsonString(
  Schema.Struct({
    stage: Schema.Literals(["created", "seeded", "upgraded"]),
    passed: Schema.Boolean,
    threads: Schema.Number,
    messages: Schema.Number,
    events: Schema.Number,
    items: Schema.Array(
      Schema.Struct({ kind: Schema.String, id: Schema.String, passed: Schema.Boolean }),
    ),
  }),
);

const decodeProbeChecks = Schema.decodeEffect(ProbeChecks);
const decodeReadbackSummary = Schema.decodeEffect(ReadbackSummary);

/**
 * Hashes the archive itself, gathers the probe and readback results the job
 * wrote, and writes `<out>/ADMISSION.json` only if the record is admitted.
 */
export const writeAdmissionRecord = Effect.fn("writeAdmissionRecord")(function* (options: {
  readonly archive: string;
  readonly expectedSha256: string;
  readonly version: string;
  readonly priorVersion: string;
  readonly priorSource: PriorReleaseSource;
  readonly verifierCommit: string;
  readonly priorCreated: string;
  readonly priorSeeded: string;
  readonly probe: string;
  readonly readback: string;
  readonly out: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const archiveSha256 = toHex(yield* crypto.digest("SHA-256", yield* fs.readFile(options.archive)));
  const probe = yield* decodeProbeChecks(yield* fs.readFileString(options.probe));
  const summary = (file: string, stage: string) =>
    Effect.flatMap(fs.readFileString(file), decodeReadbackSummary).pipe(
      Effect.filterOrFail(
        (result) => result.stage === stage,
        () => new AdmissionRefusedError({ detail: `${file} is not the ${stage} readback.` }),
      ),
    );
  const priorCreated = yield* summary(options.priorCreated, "created");
  const priorSeeded = yield* summary(options.priorSeeded, "seeded");
  const readback = yield* summary(options.readback, "upgraded");
  // Each check passes only with items of its own kind, all passed.
  const verdict = (
    result: typeof readback,
    kinds: ReadonlyArray<string>,
  ): { readonly passed: boolean; readonly failed: number } => {
    const items = result.items.filter((item) => kinds.includes(item.kind));
    const failed = items.filter((item) => !item.passed).length;
    return { passed: result.passed && items.length > 0 && failed === 0, failed };
  };
  const created = verdict(priorCreated, ["thread"]);
  const seeded = verdict(priorSeeded, ["thread", "message"]);
  const projections = verdict(readback, ["thread", "message"]);
  const eventLog = verdict(readback, ["event"]);
  const checks: ReadonlyArray<AdmissionCheck> = [
    archiveDigestCheck(archiveSha256, options.expectedSha256),
    {
      name: "prior-readback",
      passed: created.passed && seeded.passed,
      detail: `v${options.priorVersion} created ${priorCreated.threads} threads and read them back (${created.failed} not), then read back ${priorSeeded.messages} seeded messages (${seeded.failed} items not)`,
    },
    ...probe,
    {
      name: "readback",
      passed: projections.passed,
      detail: `${readback.threads} threads and ${readback.messages} messages from v${options.priorVersion}; ${projections.failed} not read back`,
    },
    {
      name: "event-log",
      passed: eventLog.passed,
      detail: `${readback.events} events from v${options.priorVersion}'s log; ${eventLog.failed} not decoded or replayed intact`,
    },
  ];
  const admitted = yield* buildAdmissionRecord({
    version: options.version,
    archiveSha256,
    expectedSha256: options.expectedSha256,
    priorVersion: options.priorVersion,
    priorSource: options.priorSource,
    verifierCommit: options.verifierCommit,
    checks,
  });
  yield* fs.makeDirectory(options.out, { recursive: true });
  yield* fs.writeFileString(path.join(options.out, ADMISSION_FILE), admitted.json);
  yield* Effect.log(admitted.json.trimEnd());
});

const command = Command.make(
  "linux-admission-record",
  {
    archive: Flag.String("archive").pipe(Flag.withDescription("The admitted Linux archive.")),
    expectedSha256: Flag.String("expected-sha256").pipe(
      Flag.withDescription("The sha256 the build job reported for the archive."),
    ),
    // `--version` is the runner's own flag.
    version: Flag.String("release-version").pipe(Flag.withDescription("The release's version.")),
    priorVersion: Flag.String("prior-version").pipe(
      Flag.withDescription("The version the admission upgraded from."),
    ),
    priorSource: Flag.Literals("prior-source", ["admitted", "bootstrap"]).pipe(
      Flag.withDescription("Whether the prior was admitted itself or named by the owner."),
    ),
    verifierCommit: Flag.String("verifier-commit").pipe(
      Flag.withDescription("The commit whose verifier scripts ran."),
    ),
    priorCreated: Flag.String("prior-created").pipe(
      Flag.withDescription("readback.ts's `created` result, from the prior."),
    ),
    priorSeeded: Flag.String("prior-seeded").pipe(
      Flag.withDescription("readback.ts's `seeded` result, from the prior."),
    ),
    probe: Flag.String("probe").pipe(Flag.withDescription("probe.ts's check results.")),
    readback: Flag.String("readback").pipe(
      Flag.withDescription("readback.ts's `upgraded` result, from the candidate."),
    ),
    out: Flag.String("out").pipe(Flag.withDescription("Directory to write ADMISSION.json into.")),
  },
  (options) => writeAdmissionRecord(options),
).pipe(
  Command.withDescription("Write ADMISSION.json only for an archive that passed every check."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
