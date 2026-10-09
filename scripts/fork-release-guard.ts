#!/usr/bin/env node

// Fork-only (atlitech/t3code). Decides whether fork-server-release.yml may
// publish a version, before any build job runs: the dispatch must come from
// atli, the version must be unused, and the commit must have passed CI.
// Runbook: docs/operations/fork-server.md.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const RELEASE_REF = "refs/heads/atli";
// The fork CI job every other ci.yml job feeds; branch protection requires it.
export const REQUIRED_CHECK = "Check";
const CHECK_APP = "github-actions";

const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-atli\.(0|[1-9][0-9]*)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly app: string | null;
}

export interface ReleaseGuardInput {
  readonly ref: string;
  readonly sha: string;
  readonly version: string;
  readonly tagExists: boolean;
  readonly releaseExists: boolean;
  readonly checkRuns: ReadonlyArray<CheckRun>;
}

export type ReleaseGuardRefusalReason =
  | "invalid_version"
  | "wrong_ref"
  | "invalid_sha"
  | "tag_exists"
  | "release_exists"
  | "check_not_passed";

export type ReleaseGuardDecision =
  | {
      readonly _tag: "Allowed";
      readonly sha: string;
      readonly version: string;
      readonly tag: string;
    }
  | {
      readonly _tag: "Refused";
      readonly reason: ReleaseGuardRefusalReason;
      readonly detail: string;
    };

const refuse = (reason: ReleaseGuardRefusalReason, detail: string): ReleaseGuardDecision => ({
  _tag: "Refused",
  reason,
  detail,
});

/**
 * The checks that need no lookups. The CLI runs them before it asks git or
 * GitHub anything, so a malformed version never reaches a command line.
 */
export const refuseRequest = (
  input: Pick<ReleaseGuardInput, "ref" | "sha" | "version">,
): ReleaseGuardDecision | undefined => {
  if (!VERSION_PATTERN.test(input.version)) {
    return refuse(
      "invalid_version",
      `Fork versions look like 0.0.46-atli.1; got '${input.version}'.`,
    );
  }
  if (input.ref !== RELEASE_REF) {
    return refuse("wrong_ref", `Releases are dispatched from atli only; got '${input.ref}'.`);
  }
  if (!SHA_PATTERN.test(input.sha)) {
    return refuse("invalid_sha", `The released commit must be a full SHA; got '${input.sha}'.`);
  }
  return undefined;
};

export const decideRelease = (input: ReleaseGuardInput): ReleaseGuardDecision => {
  const refused = refuseRequest(input);
  if (refused) return refused;

  const tag = `v${input.version}`;
  // Installed runtimes are keyed by version and never downloaded again, so a
  // version is used once: a failed release is retried under the next number.
  if (input.tagExists) {
    return refuse("tag_exists", `Tag ${tag} already exists. Bump the atli number.`);
  }
  if (input.releaseExists) {
    return refuse("release_exists", `A release for ${tag} already exists. Bump the atli number.`);
  }
  const passed = input.checkRuns.some(
    (run) =>
      run.name === REQUIRED_CHECK &&
      run.app === CHECK_APP &&
      run.status === "completed" &&
      run.conclusion === "success",
  );
  if (!passed) {
    return refuse(
      "check_not_passed",
      `Commit ${input.sha} has no successful ${REQUIRED_CHECK} run. Wait for CI on atli to pass.`,
    );
  }
  return { _tag: "Allowed", sha: input.sha, version: input.version, tag };
};

export const formatGitHubOutput = (
  decision: Extract<ReleaseGuardDecision, { _tag: "Allowed" }>,
): string => `sha=${decision.sha}\nversion=${decision.version}\ntag=${decision.tag}\n`;

export class ReleaseGuardRefusedError extends Schema.TaggedError<ReleaseGuardRefusedError>()(
  "ReleaseGuardRefusedError",
  {
    reason: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Release refused (${this.reason}): ${this.detail}`;
  }
}

export class ReleaseGuardLookupError extends Schema.TaggedError<ReleaseGuardLookupError>()(
  "ReleaseGuardLookupError",
  {
    lookup: Schema.Literals(["tag", "release", "check-runs"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    // A lookup that cannot answer never reads as "missing" or "passed".
    return `Could not check the ${this.lookup} for this release: ${this.detail}`;
  }
}

export class ReleaseGuardConfigError extends Schema.TaggedError<ReleaseGuardConfigError>()(
  "ReleaseGuardConfigError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Missing GITHUB_REF, GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_SERVER_URL, or GITHUB_OUTPUT.";
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

const run = (
  lookup: ReleaseGuardLookupError["lookup"],
  command: string,
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(command, args));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (cause) => new ReleaseGuardLookupError({ lookup, detail: `${command} failed to run`, cause }),
    ),
  );

// `--exit-code` exits 2 only when the tag is missing; anything else (128 for
// network or auth failures) must not read as "missing".
const lookupTag = (serverUrl: string, repository: string, tag: string) =>
  Effect.gen(function* () {
    const result = yield* run("tag", "git", [
      "ls-remote",
      "--exit-code",
      "--tags",
      `${serverUrl}/${repository}.git`,
      `refs/tags/${tag}`,
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 2) return false;
    return yield* new ReleaseGuardLookupError({
      lookup: "tag",
      detail: `git ls-remote exited ${result.exitCode}: ${result.stderr.trim()}`,
    });
  });

// `--include` puts the HTTP status line on stdout, so a 404 is told apart
// from every other failure.
const lookupRelease = (repository: string, tag: string) =>
  Effect.gen(function* () {
    const result = yield* run("release", "gh", [
      "api",
      "--include",
      `repos/${repository}/releases/tags/${tag}`,
    ]);
    const status = /^HTTP\/[\d.]+ (\d{3})/.exec(result.stdout)?.[1];
    if (result.exitCode === 0 && status === "200") return true;
    if (status === "404") return false;
    return yield* new ReleaseGuardLookupError({
      lookup: "release",
      detail: `gh api exited ${result.exitCode} with HTTP status ${status ?? "unknown"}: ${result.stderr.trim()}`,
    });
  });

const CheckRunLine = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    app: Schema.NullOr(Schema.String),
  }),
);
const decodeCheckRunLine = Schema.decodeEffect(CheckRunLine);

const lookupCheckRuns = (repository: string, sha: string) =>
  Effect.gen(function* () {
    const result = yield* run("check-runs", "gh", [
      "api",
      "--paginate",
      `repos/${repository}/commits/${sha}/check-runs?check_name=${REQUIRED_CHECK}&filter=all&per_page=100`,
      "--jq",
      ".check_runs[] | {name, status, conclusion, app: .app.slug}",
    ]);
    if (result.exitCode !== 0) {
      return yield* new ReleaseGuardLookupError({
        lookup: "check-runs",
        detail: `gh api exited ${result.exitCode}: ${result.stderr.trim()}`,
      });
    }
    const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
    return yield* Effect.forEach(lines, (line) =>
      decodeCheckRunLine(line).pipe(
        Effect.mapError(
          (cause) =>
            new ReleaseGuardLookupError({
              lookup: "check-runs",
              detail: "unreadable check run",
              cause,
            }),
        ),
      ),
    );
  });

export const guardRelease = Effect.fn("guardRelease")(function* (version: string) {
  const env = yield* Config.all({
    ref: Config.NonEmptyString("GITHUB_REF"),
    sha: Config.NonEmptyString("GITHUB_SHA"),
    repository: Config.NonEmptyString("GITHUB_REPOSITORY"),
    serverUrl: Config.NonEmptyString("GITHUB_SERVER_URL"),
    output: Config.NonEmptyString("GITHUB_OUTPUT"),
  }).pipe(Effect.mapError((cause) => new ReleaseGuardConfigError({ cause })));

  const request = { ref: env.ref, sha: env.sha, version };
  const early = refuseRequest(request);
  if (early?._tag === "Refused") {
    return yield* new ReleaseGuardRefusedError({ reason: early.reason, detail: early.detail });
  }

  const tag = `v${version}`;
  const [tagExists, releaseExists, checkRuns] = yield* Effect.all(
    [
      lookupTag(env.serverUrl, env.repository, tag),
      lookupRelease(env.repository, tag),
      lookupCheckRuns(env.repository, env.sha),
    ],
    { concurrency: "unbounded" },
  );

  const decision = decideRelease({ ...request, tagExists, releaseExists, checkRuns });
  if (decision._tag === "Refused") {
    return yield* new ReleaseGuardRefusedError({
      reason: decision.reason,
      detail: decision.detail,
    });
  }

  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(env.output, formatGitHubOutput(decision), { flag: "a" });
  yield* Effect.log(`Releasing ${decision.tag} from ${decision.sha}.`);
});

const command = Command.make(
  "fork-release-guard",
  {
    // `--version` is the runner's own flag.
    version: Flag.String("release-version").pipe(
      Flag.withDescription("Fork version to release, for example 0.0.46-atli.1."),
    ),
  },
  ({ version }) => guardRelease(version),
).pipe(Command.withDescription("Refuse a fork release that is not safe to publish."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
