#!/usr/bin/env node

// Fork-only (atlitech/t3code). Reads a fork release's manifest.json and
// ADMISSION.json and prints each platform's verification scope, or fails when
// the pair does not support it. fork-server-release.yml runs it only as a
// refusal guard before publishing; the evidence verdict is an independent
// reader running it on the published release.
// Runbook: docs/operations/fork-server.md#verification-scope.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import {
  admissionMismatch,
  decodeAdmissionJson,
  decodeReleaseManifestJson,
  MANIFEST_FILE,
  type VerificationScopeEntry,
} from "./fork-release-manifest.ts";
import { ADMISSION_FILE } from "./linux-admission/prior-release.ts";

export class ReleaseScopeError extends Schema.TaggedError<ReleaseScopeError>()(
  "ReleaseScopeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `The release's verification scope does not hold: ${this.detail}`;
  }
}

const describeChecks = (entry: VerificationScopeEntry): string =>
  entry.checks.map((check) => `${check.job} "${check.step}"`).join(", ");

/**
 * Checks manifest.json's verificationScope against ADMISSION.json and returns
 * one line per platform. Only the archive ADMISSION.json admits, at the
 * manifest's version and sha256, may be runtime-verified.
 */
export const readReleaseScope = (input: {
  readonly manifestJson: string;
  readonly admissionJson: string;
}) =>
  Effect.gen(function* () {
    const refuse = (detail: string) => Effect.fail(new ReleaseScopeError({ detail }));
    const manifest = yield* decodeReleaseManifestJson(input.manifestJson).pipe(
      Effect.mapError(
        (error) =>
          new ReleaseScopeError({
            detail: `${MANIFEST_FILE} is not a release manifest with a verificationScope: ${error.message}`,
          }),
      ),
    );
    const admission = yield* decodeAdmissionJson(input.admissionJson).pipe(
      Effect.mapError((error) => new ReleaseScopeError({ detail: error.detail })),
    );
    const { decision, entries } = manifest.verificationScope;

    const admitted = manifest.assets.find((asset) => asset.file === admission.archive);
    if (!admitted) {
      return yield* refuse(
        `${ADMISSION_FILE} admits ${admission.archive}, which ${MANIFEST_FILE} does not list.`,
      );
    }
    const mismatch = admissionMismatch(admission, manifest.version, admitted);
    if (mismatch !== undefined) return yield* refuse(mismatch);

    if (entries.length !== manifest.assets.length) {
      return yield* refuse(
        `${MANIFEST_FILE} lists ${manifest.assets.length} assets but ${entries.length} scope entries.`,
      );
    }
    const lines: Array<string> = [];
    for (const asset of manifest.assets) {
      const matching = entries.filter(
        (entry) =>
          entry.file === asset.file &&
          entry.platform === asset.platform &&
          entry.arch === asset.arch,
      );
      if (matching.length !== 1) {
        return yield* refuse(`${asset.file} does not have exactly one scope entry.`);
      }
      const entry = matching[0]!;
      const label = `${entry.platform} ${entry.arch} ${entry.file}`;
      if (entry.runtimeVerified !== (entry.status === "runtime-verified")) {
        return yield* refuse(
          `${label} has status ${entry.status} but runtimeVerified ${entry.runtimeVerified}.`,
        );
      }
      if (entry.checks.length === 0) return yield* refuse(`${label} names no check.`);
      if (!entry.runtimeVerified) {
        if (entry.file === admission.archive) {
          return yield* refuse(
            `${label} is admitted by ${ADMISSION_FILE} but marked build-checked.`,
          );
        }
        if (entry.admission !== undefined) {
          return yield* refuse(`${label} is build-checked but cites an admission.`);
        }
        lines.push(
          `${label}: build-checked, runtime-unverified (owner decision ${decision.date}); checks: ${describeChecks(entry)}`,
        );
        continue;
      }
      if (entry.file !== admission.archive) {
        return yield* refuse(
          `${label} is marked runtime-verified, but ${ADMISSION_FILE} admits only ${admission.archive}; the owner decision of ${decision.date} leaves it build-checked.`,
        );
      }
      if (
        entry.admission?.record !== ADMISSION_FILE ||
        entry.admission.version !== admission.version ||
        entry.admission.archiveSha256 !== admission.archiveSha256
      ) {
        return yield* refuse(`${label} cites an admission that is not ${ADMISSION_FILE}.`);
      }
      lines.push(
        `${label}: runtime-verified by ${ADMISSION_FILE} (version ${admission.version}, sha256 ${admission.archiveSha256}); checks: ${describeChecks(entry)}`,
      );
    }
    return lines;
  });

export const printReleaseScope = Effect.fn("printReleaseScope")(function* (options: {
  readonly manifest: string;
  readonly admission: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const read = (file: string) =>
    fs
      .readFileString(file)
      .pipe(Effect.mapError(() => new ReleaseScopeError({ detail: `cannot read ${file}.` })));
  const lines = yield* readReleaseScope({
    manifestJson: yield* read(options.manifest),
    admissionJson: yield* read(options.admission),
  });
  for (const line of lines) yield* Console.log(line);
});

const command = Command.make(
  "fork-release-scope",
  {
    manifest: Flag.String("manifest").pipe(Flag.withDescription("The release's manifest.json.")),
    admission: Flag.String("admission").pipe(Flag.withDescription("The release's ADMISSION.json.")),
  },
  (options) => printReleaseScope(options),
).pipe(Command.withDescription("Print and check each platform's verification scope."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
