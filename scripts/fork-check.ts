#!/usr/bin/env node

// Requires passing upstream CI, then runs fork-changed tests in their owning packages.
// See docs/operations/fork-server.md.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { hasPassedCheck, REQUIRED_CHECK } from "./fork-release-guard.ts";

const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
// Vitest's default include, so no extension a package runs is skipped.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export interface ForkTestGroup {
  /** Repository-relative package directory, where `vp run test` runs. */
  readonly packageDir: string;
  /** Test files relative to the package directory. */
  readonly files: ReadonlyArray<string>;
}

export interface ForkTestSelection {
  readonly groups: ReadonlyArray<ForkTestGroup>;
  /** Changed test files no package's `test` script runs. */
  readonly orphans: ReadonlyArray<string>;
}

/**
 * Groups changed test files under the closest package directory that has a
 * `test` script. `packageDirs` are repository-relative, "" for the root.
 */
export const selectForkTests = (
  changedPaths: ReadonlyArray<string>,
  packageDirs: ReadonlyArray<string>,
): ForkTestSelection => {
  const byDepth = [...packageDirs].toSorted((left, right) => right.length - left.length);
  const groups = new Map<string, Array<string>>();
  const orphans: Array<string> = [];
  for (const path of changedPaths) {
    if (!TEST_FILE.test(path) || path.startsWith(".repos/")) continue;
    const packageDir = byDepth.find((dir) => dir !== "" && path.startsWith(`${dir}/`));
    if (packageDir === undefined) {
      orphans.push(path);
      continue;
    }
    const files = groups.get(packageDir) ?? [];
    files.push(path.slice(packageDir.length + 1));
    groups.set(packageDir, files);
  }
  return {
    groups: [...groups.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([packageDir, files]) => ({ packageDir, files: files.toSorted() })),
    orphans: orphans.toSorted(),
  };
};

export class ForkCheckError extends Schema.TaggedError<ForkCheckError>()("ForkCheckError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
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

const spawnFailed = (command: string) => (cause: unknown) =>
  new ForkCheckError({ detail: `${command} failed to run`, cause });

/** Runs a command and returns its stdout, failing on a non-zero exit. */
const read = Effect.fn("ForkCheck.read")(
  function* (command: string, args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(command, args));
    return yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
  },
  Effect.scoped,
  (effect, command, args) =>
    effect.pipe(
      Effect.mapError(spawnFailed(command)),
      Effect.flatMap(([stdout, stderr, exitCode]) =>
        exitCode === 0
          ? Effect.succeed(stdout)
          : Effect.fail(
              new ForkCheckError({
                detail: `${command} ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`,
              }),
            ),
      ),
    ),
);

/** Runs a command in `cwd` with its output streamed to this process's own; returns the exit code. */
const runInherited = Effect.fn("ForkCheck.runInherited")(
  function* (command: string, args: ReadonlyArray<string>, cwd: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, { cwd, stdout: "inherit", stderr: "inherit" }),
    );
    return Number(yield* child.exitCode);
  },
  Effect.scoped,
  (effect, command) => effect.pipe(Effect.mapError(spawnFailed(command))),
);

const CheckRunLine = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    app: Schema.NullOr(Schema.String),
  }),
);
const decodeCheckRunLine = Schema.decodeEffect(CheckRunLine);

/** The newest upstream commit HEAD contains. */
const upstreamBase = Effect.gen(function* () {
  yield* read("git", [
    "fetch",
    "--quiet",
    "--no-tags",
    "--filter=blob:none",
    `https://github.com/${UPSTREAM_REPOSITORY}.git`,
    "main",
  ]);
  return (yield* read("git", ["merge-base", "HEAD", "FETCH_HEAD"])).trim();
});

const upstreamCheckRuns = Effect.fn("upstreamCheckRuns")(function* (sha: string) {
  const stdout = yield* read("gh", [
    "api",
    "--paginate",
    `repos/${UPSTREAM_REPOSITORY}/commits/${sha}/check-runs?check_name=${REQUIRED_CHECK}&filter=all&per_page=100`,
    "--jq",
    ".check_runs[] | {name, status, conclusion, app: .app.slug}",
  ]);
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  return yield* Effect.forEach(lines, (line) =>
    decodeCheckRunLine(line).pipe(
      Effect.mapError((cause) => new ForkCheckError({ detail: "unreadable check run", cause })),
    ),
  );
});

const PackageScripts = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
);
const decodePackageScripts = Schema.decodeEffect(PackageScripts);

/** Repository-relative directories of the tracked packages that have a `test` script. */
const testedPackageDirs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const manifests = (yield* read("git", [
    "ls-files",
    "-z",
    "--",
    "package.json",
    "**/package.json",
  ]))
    .split("\0")
    .filter((path) => path.length > 0 && !path.startsWith(".repos/"));
  const dirs = yield* Effect.forEach(manifests, (manifest) =>
    fs.readFileString(manifest).pipe(
      Effect.flatMap(decodePackageScripts),
      Effect.map((pkg) =>
        pkg.scripts?.test === undefined ? undefined : manifest.slice(0, -"package.json".length),
      ),
      Effect.mapError((cause) => new ForkCheckError({ detail: `unreadable ${manifest}`, cause })),
    ),
  );
  return dirs
    .filter((dir): dir is string => dir !== undefined)
    .map((dir) => dir.replace(/\/$/, ""));
});

export const forkCheck = Effect.fn("forkCheck")(function* () {
  const base = yield* upstreamBase;
  yield* Effect.log(`Built on upstream ${UPSTREAM_REPOSITORY}@${base}.`);

  if (!hasPassedCheck(yield* upstreamCheckRuns(base))) {
    return yield* new ForkCheckError({
      detail: `Upstream ${base} has no successful ${REQUIRED_CHECK} run. Merge an upstream commit whose CI passed.`,
    });
  }
  yield* Effect.log(`Upstream ${base} passed its ${REQUIRED_CHECK}.`);

  // -z: raw paths, NUL-separated; without it git quotes unusual ones.
  const changed = (yield* read("git", [
    "diff",
    "-z",
    "--name-only",
    "--diff-filter=d",
    base,
    "HEAD",
  ]))
    .split("\0")
    .filter((path) => path.length > 0);
  const selection = selectForkTests(changed, yield* testedPackageDirs);
  if (selection.orphans.length > 0) {
    return yield* new ForkCheckError({
      detail: `No package runs these fork test files: ${selection.orphans.join(", ")}`,
    });
  }

  const failed: Array<string> = [];
  for (const group of selection.groups) {
    yield* Effect.log(`${group.packageDir}: ${group.files.length} fork test file(s).`);
    const exitCode = yield* runInherited("vp", ["run", "test", ...group.files], group.packageDir);
    if (exitCode !== 0) failed.push(group.packageDir);
  }
  if (failed.length > 0) {
    return yield* new ForkCheckError({ detail: `Fork tests failed in ${failed.join(", ")}.` });
  }
});

const command = Command.make("fork-check", {}, () => forkCheck()).pipe(
  Command.withDescription("Check the fork's changes on top of a green upstream commit."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
