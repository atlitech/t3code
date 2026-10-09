#!/usr/bin/env node

// Fork-only (atlitech/t3code). Picks the release the Linux admission upgrades
// from: the newest earlier fork release that was itself admitted (it carries
// ADMISSION.json). Before any release was admitted, the owner names one with
// the workflow's bootstrap input, and the admission record says so.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const ADMISSION_FILE = "ADMISSION.json";

// The fork version format fork-release-guard.ts enforces.
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-atli\.(0|[1-9][0-9]*)$/;

export interface PublishedRelease {
  readonly tagName: string;
  readonly draft: boolean;
  readonly assets: ReadonlyArray<string>;
}

export type PriorReleaseSource = "admitted" | "bootstrap";

export type PriorReleaseDecision =
  | { readonly _tag: "Selected"; readonly version: string; readonly source: PriorReleaseSource }
  | {
      readonly _tag: "Refused";
      readonly reason:
        | "invalid_version"
        | "no_admitted_release"
        | "bootstrap_not_needed"
        | "bootstrap_not_usable";
      readonly detail: string;
    };

export const isForkVersion = (version: string): boolean => VERSION_PATTERN.test(version);

const versionParts = (version: string): ReadonlyArray<number> | undefined => {
  const match = VERSION_PATTERN.exec(version);
  return match ? match.slice(1, 5).map(Number) : undefined;
};

/** Orders fork versions numerically: 0.0.46-atli.10 is newer than 0.0.46-atli.9. */
export const compareVersions = (left: string, right: string): number => {
  const a = versionParts(left) ?? [];
  const b = versionParts(right) ?? [];
  for (let index = 0; index < 4; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const versionOf = (release: PublishedRelease) =>
  release.tagName.startsWith("v") && versionParts(release.tagName.slice(1))
    ? release.tagName.slice(1)
    : undefined;

// A release the admission can install: published, earlier than the
// candidate, with the Linux archive and the SHA256SUMS that verifies it.
const installable = (release: PublishedRelease, candidate: string) => {
  const version = versionOf(release);
  return (
    version !== undefined &&
    !release.draft &&
    compareVersions(version, candidate) < 0 &&
    release.assets.includes(`t3-${version}-linux-x64.tar.gz`) &&
    release.assets.includes("SHA256SUMS")
  );
};

const refuse = (
  reason: Extract<PriorReleaseDecision, { _tag: "Refused" }>["reason"],
  detail: string,
): PriorReleaseDecision => ({ _tag: "Refused", reason, detail });

export const selectPriorRelease = (input: {
  readonly releases: ReadonlyArray<PublishedRelease>;
  readonly candidateVersion: string;
  readonly bootstrap: string;
}): PriorReleaseDecision => {
  if (!versionParts(input.candidateVersion)) {
    return refuse("invalid_version", `'${input.candidateVersion}' is not a fork version.`);
  }
  const admitted = input.releases
    .filter(
      (release) =>
        installable(release, input.candidateVersion) && release.assets.includes(ADMISSION_FILE),
    )
    .map((release) => versionOf(release)!)
    .toSorted(compareVersions)
    .at(-1);
  const bootstrap = input.bootstrap.trim();
  if (admitted !== undefined) {
    // Once a release is admitted, the chain continues from it; an override
    // would let a release skip the upgrade its users actually make.
    if (bootstrap.length > 0) {
      return refuse(
        "bootstrap_not_needed",
        `v${admitted} is already admitted; leave the bootstrap input empty.`,
      );
    }
    return { _tag: "Selected", version: admitted, source: "admitted" };
  }
  if (bootstrap.length === 0) {
    return refuse(
      "no_admitted_release",
      "No earlier release carries ADMISSION.json. For the first admission, name the prior release in the bootstrap input.",
    );
  }
  const named = input.releases.find((release) => versionOf(release) === bootstrap);
  if (!named || !installable(named, input.candidateVersion)) {
    return refuse(
      "bootstrap_not_usable",
      `'${bootstrap}' is not an earlier published release with t3-${bootstrap}-linux-x64.tar.gz and SHA256SUMS.`,
    );
  }
  return { _tag: "Selected", version: bootstrap, source: "bootstrap" };
};

export class PriorReleaseError extends Schema.TaggedError<PriorReleaseError>()(
  "PriorReleaseError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Cannot choose the release to upgrade from: ${this.detail}`;
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

const ReleaseLine = Schema.fromJsonString(
  Schema.Struct({
    tagName: Schema.String,
    draft: Schema.Boolean,
    assets: Schema.Array(Schema.String),
  }),
);
const decodeReleaseLine = Schema.decodeEffect(ReleaseLine);

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
      return yield* new PriorReleaseError({
        detail: `gh api exited ${exitCode}: ${stderr.trim()}`,
      });
    }
    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    return yield* Effect.forEach(lines, (line) => decodeReleaseLine(line));
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      cause._tag === "PriorReleaseError"
        ? cause
        : new PriorReleaseError({ detail: "could not list releases", cause }),
    ),
  );

export const resolvePriorRelease = Effect.fn("resolvePriorRelease")(function* (options: {
  readonly repo: string;
  readonly releaseVersion: string;
  readonly bootstrap: string;
}) {
  const output = yield* Config.NonEmptyString("GITHUB_OUTPUT").pipe(
    Effect.mapError(
      (cause) => new PriorReleaseError({ detail: "GITHUB_OUTPUT is not set", cause }),
    ),
  );
  const releases = yield* listReleases(options.repo);
  const decision = selectPriorRelease({
    releases,
    candidateVersion: options.releaseVersion,
    bootstrap: options.bootstrap,
  });
  if (decision._tag === "Refused") {
    return yield* new PriorReleaseError({ detail: `${decision.reason}: ${decision.detail}` });
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(output, `version=${decision.version}\nsource=${decision.source}\n`, {
    flag: "a",
  });
  yield* Effect.log(`Upgrading from v${decision.version} (${decision.source}).`);
});

const command = Command.make(
  "linux-admission-prior-release",
  {
    repo: Flag.String("repo").pipe(Flag.withDescription("owner/name of the fork.")),
    // `--version` is the runner's own flag.
    releaseVersion: Flag.String("release-version").pipe(
      Flag.withDescription("The candidate's fork version."),
    ),
    bootstrap: Flag.String("bootstrap").pipe(
      Flag.withDescription("Owner-named prior version, only before any release is admitted."),
      Flag.withDefault(""),
    ),
  },
  (options) => resolvePriorRelease(options),
).pipe(Command.withDescription("Choose the admitted release a candidate upgrades from."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
