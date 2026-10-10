#!/usr/bin/env node

// Fork-only (atlitech/t3code). Picks the release the recovery drill upgrades
// to: the one the owner named, or the newest admitted release. Either way it
// must be a published fork release that carries ADMISSION.json, since the
// drill upgrades from that record's priorVersion.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  ADMISSION_FILE,
  compareVersions,
  isForkVersion,
  type PublishedRelease,
} from "../linux-admission/prior-release.ts";

export type DrillTargetDecision =
  | { readonly _tag: "Selected"; readonly version: string }
  | {
      readonly _tag: "Refused";
      readonly reason: "invalid_version" | "not_admitted" | "no_admitted_release";
      readonly detail: string;
    };

const versionOf = (release: PublishedRelease) =>
  release.tagName.startsWith("v") && isForkVersion(release.tagName.slice(1))
    ? release.tagName.slice(1)
    : undefined;

// A release the drill can install and upgrade to on Linux: published, with
// its Linux archive, the SHA256SUMS that verifies it, and its admission record.
const drillable = (release: PublishedRelease) => {
  const version = versionOf(release);
  return (
    version !== undefined &&
    !release.draft &&
    release.assets.includes(`t3-${version}-linux-x64.tar.gz`) &&
    release.assets.includes("SHA256SUMS") &&
    release.assets.includes(ADMISSION_FILE)
  );
};

export const selectDrillTarget = (input: {
  readonly releases: ReadonlyArray<PublishedRelease>;
  readonly requested: string;
}): DrillTargetDecision => {
  const admitted = input.releases
    .filter(drillable)
    .map((release) => versionOf(release)!)
    .toSorted(compareVersions);
  const requested = input.requested.trim();
  if (requested.length === 0) {
    const newest = admitted.at(-1);
    return newest === undefined
      ? {
          _tag: "Refused",
          reason: "no_admitted_release",
          detail: `No published release carries ${ADMISSION_FILE} with its Linux archive and SHA256SUMS.`,
        }
      : { _tag: "Selected", version: newest };
  }
  if (!isForkVersion(requested)) {
    return {
      _tag: "Refused",
      reason: "invalid_version",
      detail: `'${requested}' is not a fork version (X.Y.Z-atli.N).`,
    };
  }
  if (!admitted.includes(requested)) {
    return {
      _tag: "Refused",
      reason: "not_admitted",
      detail: `v${requested} is not a published release with ${ADMISSION_FILE}, t3-${requested}-linux-x64.tar.gz, and SHA256SUMS.`,
    };
  }
  return { _tag: "Selected", version: requested };
};

export class DrillTargetError extends Schema.TaggedError<DrillTargetError>()("DrillTargetError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Cannot choose the release to drill: ${this.detail}`;
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const decodeReleaseLine = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      tagName: Schema.String,
      draft: Schema.Boolean,
      assets: Schema.Array(Schema.String),
    }),
  ),
);

const listReleases = (repository: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("gh", [
        "api",
        "--paginate",
        `repos/${repository}/releases?per_page=100`,
        "--jq",
        ".[] | {tagName: .tag_name, draft, assets: [.assets[].name]}",
      ]),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new DrillTargetError({ detail: `gh api exited ${exitCode}: ${stderr.trim()}` });
    }
    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    return yield* Effect.forEach(lines, (line) => decodeReleaseLine(line));
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      cause._tag === "DrillTargetError"
        ? cause
        : new DrillTargetError({ detail: "could not list releases", cause }),
    ),
  );

export const resolveDrillTarget = Effect.fn("resolveDrillTarget")(function* (options: {
  readonly repo: string;
  readonly targetVersion: string;
}) {
  const output = yield* Config.NonEmptyString("GITHUB_OUTPUT").pipe(
    Effect.mapError((cause) => new DrillTargetError({ detail: "GITHUB_OUTPUT is not set", cause })),
  );
  const releases = yield* listReleases(options.repo);
  const decision = selectDrillTarget({ releases, requested: options.targetVersion });
  if (decision._tag === "Refused") {
    return yield* new DrillTargetError({ detail: `${decision.reason}: ${decision.detail}` });
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(output, `version=${decision.version}\n`, { flag: "a" });
  yield* Effect.log(`Drilling the upgrade to v${decision.version}.`);
});

const command = Command.make(
  "linux-recovery-drill-target",
  {
    repo: Flag.String("repo").pipe(Flag.withDescription("owner/name of the fork.")),
    // `--version` is the runner's own flag.
    targetVersion: Flag.String("target-version").pipe(
      Flag.withDescription("Admitted fork version to upgrade to; empty for the newest admitted."),
      Flag.withDefault(""),
    ),
  },
  (options) => resolveDrillTarget(options),
).pipe(Command.withDescription("Choose the admitted release a recovery drill upgrades to."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
