import { assert, it as effectIt } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "vite-plus/test";

import {
  decideRelease,
  formatGitHubOutput,
  guardRelease,
  type CheckRun,
  type ReleaseGuardInput,
} from "./fork-release-guard.ts";

const sha = "0447af610f0447af610f0447af610f0447af610f";

const passedCheck: CheckRun = {
  name: "Check",
  status: "completed",
  conclusion: "success",
  app: "github-actions",
};

const input = (overrides: Partial<ReleaseGuardInput> = {}): ReleaseGuardInput => ({
  ref: "refs/heads/atli",
  sha,
  version: "0.0.46-atli.1",
  tagExists: false,
  releaseExists: false,
  checkRuns: [passedCheck],
  ...overrides,
});

const reasonFor = (overrides: Partial<ReleaseGuardInput>) => {
  const decision = decideRelease(input(overrides));
  return decision._tag === "Refused" ? decision.reason : undefined;
};

describe("fork release guard", () => {
  it("allows an unused version dispatched from atli on a commit that passed Check", () => {
    const decision = decideRelease(input());
    expect(decision).toEqual({
      _tag: "Allowed",
      sha,
      version: "0.0.46-atli.1",
      tag: "v0.0.46-atli.1",
    });
    if (decision._tag !== "Allowed") return;
    expect(formatGitHubOutput(decision)).toBe(
      `sha=${sha}\nversion=0.0.46-atli.1\ntag=v0.0.46-atli.1\n`,
    );
  });

  it("allows a commit whose Check passed on a rerun after a failure", () => {
    const failed = { ...passedCheck, conclusion: "failure" };
    expect(decideRelease(input({ checkRuns: [failed, passedCheck] }))._tag).toBe("Allowed");
  });

  it("refuses a dispatch from any ref other than atli", () => {
    for (const ref of [
      "refs/heads/main",
      "refs/heads/feature/atli",
      "refs/tags/v0.0.46-atli.1",
      "atli",
    ]) {
      expect(reasonFor({ ref }), ref).toBe("wrong_ref");
    }
  });

  it("refuses a version that is not <patch>-atli.<n>", () => {
    for (const version of [
      "v0.0.46-atli.1",
      "0.0.46",
      "0.0.46-atli.01",
      "0.0.46-nightly.1",
      "0.0.46-atli.1 ",
    ]) {
      expect(reasonFor({ version }), version).toBe("invalid_version");
    }
  });

  it("refuses a released commit that is not a full SHA", () => {
    expect(reasonFor({ sha: "0447af610f" })).toBe("invalid_sha");
  });

  it("refuses a version whose tag already exists", () => {
    expect(reasonFor({ tagExists: true })).toBe("tag_exists");
  });

  it("refuses a version whose release already exists", () => {
    expect(reasonFor({ releaseExists: true })).toBe("release_exists");
  });

  it("refuses a commit without a successful Check run", () => {
    const cases: ReadonlyArray<ReadonlyArray<CheckRun>> = [
      [],
      [{ ...passedCheck, conclusion: "failure" }],
      [{ ...passedCheck, conclusion: "cancelled" }],
      [{ ...passedCheck, conclusion: "skipped" }],
      [{ ...passedCheck, status: "in_progress", conclusion: null }],
      [{ ...passedCheck, name: "Lint" }],
      [{ ...passedCheck, app: "another-app" }],
      [{ ...passedCheck, app: null }],
    ];
    for (const checkRuns of cases) {
      expect(reasonFor({ checkRuns }), JSON.stringify(checkRuns)).toBe("check_not_passed");
    }
  });
});

const encoder = new TextEncoder();

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const mockHandle = (result: ProcessResult) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const checkRunLine = (run: CheckRun) => JSON.stringify(run);

interface Lookups {
  readonly tag: ProcessResult;
  readonly release: ProcessResult;
  readonly checkRuns: ProcessResult;
}

// An unused version on a commit whose Check passed.
const allowedLookups: Lookups = {
  tag: { exitCode: 2 },
  release: { exitCode: 1, stdout: "HTTP/2.0 404 Not Found\r\n\r\n{}", stderr: "Not Found" },
  checkRuns: { exitCode: 0, stdout: `${checkRunLine(passedCheck)}\n` },
};

const outputPath = "/tmp/fork-release-guard-github-output";

const runGuard = (
  lookups: Partial<Lookups> = {},
  options: { readonly ref?: string; readonly version?: string } = {},
) =>
  Effect.gen(function* () {
    const results = { ...allowedLookups, ...lookups };
    const spawned: Array<string> = [];
    const writes: Array<{ readonly path: string; readonly data: string; readonly flag?: string }> =
      [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) {
        return Effect.die(new Error("unexpected piped command"));
      }
      const line = [command.command, ...command.args].join(" ");
      spawned.push(line);
      const result =
        command.command === "git"
          ? results.tag
          : command.args.includes("--include")
            ? results.release
            : results.checkRuns;
      return Effect.succeed(mockHandle(result));
    });
    const fileSystem = FileSystem.makeNoop({
      writeFileString: (path, data, writeOptions) =>
        Effect.sync(() => {
          writes.push({ path, data, ...(writeOptions?.flag ? { flag: writeOptions.flag } : {}) });
        }),
    });
    const exit = yield* guardRelease(options.version ?? "0.0.46-atli.1").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            GITHUB_REF: options.ref ?? "refs/heads/atli",
            GITHUB_SHA: sha,
            GITHUB_REPOSITORY: "atlitech/t3code",
            GITHUB_SERVER_URL: "https://github.com",
            GITHUB_OUTPUT: outputPath,
          },
        }),
      ),
      Effect.exit,
    );
    return { exit, spawned, writes };
  });

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (exit._tag !== "Failure") return assert.fail("Expected the guard to fail");
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (failure?._tag !== "Fail") return assert.fail(`Expected a typed failure: ${exit.cause}`);
  return failure.error;
};

const refusalReason = (exit: Parameters<typeof failureOf>[0]) => {
  const error = failureOf(exit) as { readonly _tag: string; readonly reason?: string };
  assert.equal(error._tag, "ReleaseGuardRefusedError");
  return error.reason;
};

const lookupFailure = (exit: Parameters<typeof failureOf>[0]) => {
  const error = failureOf(exit) as { readonly _tag: string; readonly lookup?: string };
  assert.equal(error._tag, "ReleaseGuardLookupError");
  return error.lookup;
};

describe("fork release guard lookups", () => {
  effectIt.effect("appends sha, version, and tag to GITHUB_OUTPUT when allowed", () =>
    Effect.gen(function* () {
      const { exit, spawned, writes } = yield* runGuard();
      assert.equal(exit._tag, "Success");
      assert.deepStrictEqual(writes, [
        {
          path: outputPath,
          data: `sha=${sha}\nversion=0.0.46-atli.1\ntag=v0.0.46-atli.1\n`,
          flag: "a",
        },
      ]);
      assert.deepStrictEqual(spawned.toSorted(), [
        `gh api --include repos/atlitech/t3code/releases/tags/v0.0.46-atli.1`,
        `gh api --paginate repos/atlitech/t3code/commits/${sha}/check-runs?check_name=Check&filter=all&per_page=100 --jq .check_runs[] | {name, status, conclusion, app: .app.slug}`,
        `git ls-remote --exit-code --tags https://github.com/atlitech/t3code.git refs/tags/v0.0.46-atli.1`,
      ]);
    }),
  );

  effectIt.effect("refuses before spawning anything for a wrong ref or invalid version", () =>
    Effect.gen(function* () {
      for (const [options, reason] of [
        [{ ref: "refs/heads/main" }, "wrong_ref"],
        [{ version: "0.0.46; rm -rf /" }, "invalid_version"],
      ] as const) {
        const { exit, spawned, writes } = yield* runGuard({}, options);
        assert.equal(refusalReason(exit), reason);
        assert.deepStrictEqual(spawned, []);
        assert.deepStrictEqual(writes, []);
      }
    }),
  );

  effectIt.effect("reads git ls-remote exit 0 as an existing tag and 128 as a lookup error", () =>
    Effect.gen(function* () {
      const existing = yield* runGuard({ tag: { exitCode: 0, stdout: `${sha}\trefs/tags/v` } });
      assert.equal(refusalReason(existing.exit), "tag_exists");
      assert.deepStrictEqual(existing.writes, []);

      const unreachable = yield* runGuard({
        tag: { exitCode: 128, stderr: "fatal: could not read from remote" },
      });
      assert.equal(lookupFailure(unreachable.exit), "tag");
      assert.deepStrictEqual(unreachable.writes, []);
    }),
  );

  effectIt.effect("reads the release status line and fails closed on anything but 200 or 404", () =>
    Effect.gen(function* () {
      const existing = yield* runGuard({
        release: { exitCode: 0, stdout: "HTTP/2.0 200 OK\r\n\r\n{}" },
      });
      assert.equal(refusalReason(existing.exit), "release_exists");
      assert.deepStrictEqual(existing.writes, []);

      for (const release of [
        { exitCode: 1, stdout: "HTTP/2.0 500 Internal Server Error\r\n\r\n{}" },
        { exitCode: 1, stdout: "HTTP/2.0 401 Unauthorized\r\n\r\n{}" },
        { exitCode: 1, stderr: "error connecting to api.github.com" },
        { exitCode: 1, stdout: "HTTP/2.0 200 OK\r\n\r\n{}" },
        { exitCode: 0, stdout: "{}" },
      ]) {
        const { exit, writes } = yield* runGuard({ release });
        assert.equal(lookupFailure(exit), "release", JSON.stringify(release));
        assert.deepStrictEqual(writes, []);
      }
    }),
  );

  effectIt.effect("refuses check runs that are failed, missing, or from another app", () =>
    Effect.gen(function* () {
      for (const stdout of [
        "",
        `${checkRunLine({ ...passedCheck, conclusion: "failure" })}\n`,
        `${checkRunLine({ ...passedCheck, app: "another-app" })}\n`,
      ]) {
        const { exit, writes } = yield* runGuard({ checkRuns: { exitCode: 0, stdout } });
        assert.equal(refusalReason(exit), "check_not_passed", stdout);
        assert.deepStrictEqual(writes, []);
      }
    }),
  );

  effectIt.effect("fails closed on an unreadable or failed check-runs lookup", () =>
    Effect.gen(function* () {
      for (const checkRuns of [
        { exitCode: 0, stdout: `${checkRunLine(passedCheck)}\n{"name":"Check"\n` },
        { exitCode: 0, stdout: `{"name":"Check","status":"completed"}\n` },
        { exitCode: 1, stderr: "HTTP 502" },
      ]) {
        const { exit, writes } = yield* runGuard({ checkRuns });
        assert.equal(lookupFailure(exit), "check-runs", JSON.stringify(checkRuns));
        assert.deepStrictEqual(writes, []);
      }
    }),
  );
});
