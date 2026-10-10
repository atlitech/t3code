#!/usr/bin/env node

// Fork-only (atlitech/t3code). Writes a fork release's notes from its
// manifest.json: the Linux x64 server is runtime-verified, and the Mac and
// Android packages are build-checked but runtime-unverified. Refuses a
// manifest that marks Mac or Android runtime-verified.
// Runbook: docs/operations/fork-server.md#verification-scope.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import {
  decodeReleaseManifestJson,
  MANIFEST_FILE,
  type ReleaseManifest,
  type VerificationScopeEntry,
} from "./fork-release-manifest.ts";

export class ReleaseNotesError extends Schema.TaggedError<ReleaseNotesError>()(
  "ReleaseNotesError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Cannot write the release notes: ${this.detail}`;
  }
}

// Each platform a release carries, in the order the notes list them.
const PLATFORMS = [
  { platform: "linux", arch: "x64", label: "Linux x64 server", runtimeVerified: true },
  { platform: "darwin", arch: "arm64", label: "Mac arm64 desktop app", runtimeVerified: false },
  {
    platform: "android",
    arch: "arm64-v8a",
    label: "Android arm64-v8a APK",
    runtimeVerified: false,
  },
] as const;

const checkNames = (entry: VerificationScopeEntry): string =>
  entry.checks.map((check) => `${check.job} "${check.step}"`).join(" and ");

/** The notes for `manifest`: one line per platform, stating its scope. */
export const buildReleaseNotes = (manifest: ReleaseManifest) =>
  Effect.gen(function* () {
    const refuse = (detail: string) => Effect.fail(new ReleaseNotesError({ detail }));
    const { decision, entries } = manifest.verificationScope;
    for (const entry of entries) {
      if (!PLATFORMS.some((p) => p.platform === entry.platform && p.arch === entry.arch)) {
        return yield* refuse(`${entry.platform} ${entry.arch} is not a fork release platform.`);
      }
    }
    const lines: Array<string> = [];
    for (const platform of PLATFORMS) {
      const matching = entries.filter(
        (entry) => entry.platform === platform.platform && entry.arch === platform.arch,
      );
      if (matching.length !== 1) {
        return yield* refuse(`the manifest needs exactly one ${platform.label} scope entry.`);
      }
      const entry = matching[0]!;
      const claimsRuntime = entry.runtimeVerified || entry.status === "runtime-verified";
      if (platform.runtimeVerified) {
        if (!claimsRuntime || entry.admission === undefined) {
          return yield* refuse(`the ${platform.label} is not runtime-verified by an admission.`);
        }
        lines.push(
          `- ${platform.label}, \`${entry.file}\`: runtime-verified. ${entry.admission.record} admitted this archive (version ${entry.admission.version}, sha256 \`${entry.admission.archiveSha256}\`) after it upgraded over the prior release's data and ran; checked by ${checkNames(entry)}.`,
        );
        continue;
      }
      if (claimsRuntime) {
        return yield* refuse(
          `the ${platform.label} is marked runtime-verified, but the owner decision of ${decision.date} leaves it build-checked.`,
        );
      }
      const line = `- ${platform.label}, \`${entry.file}\`: build-checked but runtime-unverified. Checked by ${checkNames(entry)}; never run by the release.`;
      // The step names come from the manifest; none may smuggle the claim in.
      if (/runtime-verified/i.test(line)) {
        return yield* refuse(`the ${platform.label} line would say runtime-verified.`);
      }
      lines.push(line);
    }
    return [
      `T3 Code ${manifest.version}, the atli fork, built from commit ${manifest.commit}.`,
      "",
      `Verification scope, as ${MANIFEST_FILE}'s verificationScope records it:`,
      "",
      ...lines,
      "",
      `Mac and Android are build-checked but runtime-unverified by the ${decision.by} decision of ${decision.date}: ${decision.text} See ${decision.runbook}.`,
      "",
      "Install them with docs/operations/fork-server.md.",
      "",
    ].join("\n");
  });

export const writeReleaseNotes = Effect.fn("writeReleaseNotes")(function* (options: {
  readonly manifest: string;
  readonly out: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const manifest = yield* fs.readFileString(options.manifest).pipe(
    Effect.mapError(() => new ReleaseNotesError({ detail: `cannot read ${options.manifest}.` })),
    Effect.flatMap((text) =>
      decodeReleaseManifestJson(text).pipe(
        Effect.mapError(
          (error) =>
            new ReleaseNotesError({
              detail: `${options.manifest} is not a release manifest: ${error.message}`,
            }),
        ),
      ),
    ),
  );
  const notes = yield* buildReleaseNotes(manifest);
  yield* fs.writeFileString(options.out, notes);
  yield* Effect.log(notes.trimEnd());
});

const command = Command.make(
  "fork-release-notes",
  {
    manifest: Flag.String("manifest").pipe(Flag.withDescription("The release's manifest.json.")),
    out: Flag.String("out").pipe(Flag.withDescription("File to write the notes to.")),
  },
  (options) => writeReleaseNotes(options),
).pipe(Command.withDescription("Write a fork release's notes from its manifest.json."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
