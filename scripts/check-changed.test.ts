import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { defaultConcurrency, git, gitPaths, runSteps, type Step } from "./check-changed.ts";

const GiB = 1024 ** 3;

describe("check:changed", () => {
  it.live("lists changed and untracked paths without quoting or splitting filenames", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* git(root, ["init"]);
        const names = ["café.test.cjs", "日本語.test.cjs", "line\nbreak.ts"];
        for (const name of names) yield* fs.writeFileString(path.join(root, name), "original");
        assert.deepStrictEqual(
          (yield* gitPaths(root, ["ls-files", "--others", "--exclude-standard"])).sort(),
          [...names].sort(),
        );
        yield* git(root, ["add", "."]);
        for (const name of names) yield* fs.writeFileString(path.join(root, name), "changed");
        assert.deepStrictEqual(
          (yield* gitPaths(root, ["diff", "--name-only", "--"])).sort(),
          [...names].sort(),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
  });

  it.effect(
    "keeps weighted steps within the budget, in order, and serial steps one at a time",
    () =>
      Effect.gen(function* () {
        const startedAt: Record<string, number> = {};
        let active = 0;
        let maxActive = 0;
        let serialActive = 0;
        let maxSerial = 0;
        const step = (
          name: string,
          options: { weight?: number; serial?: boolean } = {},
        ): Step<never> => {
          const slots = Math.min(options.weight ?? 1, 3);
          return {
            name,
            ...options,
            run: Effect.gen(function* () {
              startedAt[name] = (yield* Clock.currentTimeMillis) / 1000;
              active += slots;
              maxActive = Math.max(maxActive, active);
              if (options.serial) maxSerial = Math.max(maxSerial, ++serialActive);
              yield* Effect.sleep("1 second");
              active -= slots;
              if (options.serial) serialActive--;
              return { ok: true, output: "" };
            }),
          };
        };
        const fiber = yield* runSteps(
          [
            step("light 1"),
            // Above the budget, so it holds every slot rather than never starting.
            step("heavy", { weight: 5 }),
            step("pair", { weight: 2 }),
            step("light 2"),
            step("test 1", { serial: true }),
            step("test 2", { serial: true }),
          ],
          { concurrency: 3, timeoutSeconds: 60 },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const results = yield* Fiber.join(fiber);

        assert.deepStrictEqual(
          results.map((result) => result.outcome),
          ["pass", "pass", "pass", "pass", "pass", "pass"],
        );
        assert.strictEqual(maxActive, 3);
        // Lighter steps queued behind the heavy one never start ahead of it.
        assert.deepStrictEqual(startedAt, {
          "light 1": 0,
          heavy: 1,
          pair: 2,
          "light 2": 2,
          "test 1": 3,
          "test 2": 4,
        });
        assert.strictEqual(maxSerial, 1);
      }),
  );

  it.effect("interrupts a step at its timeout and reports TIMEOUT, apart from FAIL", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runSteps(
        [
          {
            name: "hangs",
            run: Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            ),
          },
          { name: "fails", run: Effect.succeed({ ok: false, output: "error" }) },
          { name: "passes", run: Effect.succeed({ ok: true, output: "" }) },
        ],
        { concurrency: 3, timeoutSeconds: 10 },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      assert.isFalse(interrupted);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(fiber);

      assert.isTrue(interrupted);
      assert.deepStrictEqual(
        results.map(({ name, outcome, time }) => [name, outcome, time]),
        [
          ["hangs", "TIMEOUT", "killed after 10s"],
          ["fails", "FAIL", "0.0s"],
          ["passes", "pass", "0.0s"],
        ],
      );
    }),
  );

  it.effect("fails instead of returning an empty file list when git exits nonzero", () => {
    const spawner = (exitCode: number) =>
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(
              Stream.make(
                exitCode === 0 ? "a.ts\0café.test.cjs\0日本語.test.cjs\0line\nbreak.ts\0" : "",
              ),
            ),
            stderr: Stream.encodeText(
              Stream.make(exitCode === 0 ? "" : "fatal: index file corrupt"),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    return Effect.gen(function* () {
      const listed = yield* gitPaths("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(0)),
      );
      assert.deepStrictEqual(listed, [
        "a.ts",
        "café.test.cjs",
        "日本語.test.cjs",
        "line\nbreak.ts",
      ]);
      const error = yield* gitPaths("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(128)),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        "check:changed: git ls-files -z exited with 128: fatal: index file corrupt",
      );
    });
  });
});
