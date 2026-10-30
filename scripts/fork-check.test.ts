import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import { hasPassedCheck } from "./fork-release-guard.ts";

import { ForkCheckError, upstreamCheckRuns, selectForkTests } from "./fork-check.ts";

const packageDirs = ["", "apps/server", "packages/shared", "scripts"];

describe("selectForkTests", () => {
  it("runs each changed test file in the closest package that has a test script", () => {
    const selection = selectForkTests(
      [
        "scripts/fork-release-guard.test.ts",
        "apps/server/src/cloud/releaseAdmission.test.ts",
        "apps/server/src/cli/recover.test.ts",
        "packages/shared/src/agentAwareness.test.ts",
        "scripts/linux-admission/probe.test.ts",
      ],
      packageDirs,
    );
    expect(selection).toEqual({
      groups: [
        {
          packageDir: "apps/server",
          files: ["src/cli/recover.test.ts", "src/cloud/releaseAdmission.test.ts"],
        },
        { packageDir: "packages/shared", files: ["src/agentAwareness.test.ts"] },
        {
          packageDir: "scripts",
          files: ["fork-release-guard.test.ts", "linux-admission/probe.test.ts"],
        },
      ],
      orphans: [],
    });
  });

  it("selects every extension Vitest runs", () => {
    const selection = selectForkTests(
      [
        "apps/desktop/scripts/electron-launcher.test.mjs",
        "apps/desktop/gnome-extension/captureService.test.js",
        "packages/shared/src/thing.spec.cts",
      ],
      [...packageDirs, "apps/desktop"],
    );
    expect(selection.groups).toEqual([
      {
        packageDir: "apps/desktop",
        files: ["gnome-extension/captureService.test.js", "scripts/electron-launcher.test.mjs"],
      },
      { packageDir: "packages/shared", files: ["src/thing.spec.cts"] },
    ]);
  });

  it("skips source files and vendored references", () => {
    const selection = selectForkTests(
      [
        "apps/server/src/cloud/releaseAdmission.ts",
        "docs/operations/fork-server.md",
        ".repos/effect-smol/packages/effect/test/Atom.test.ts",
      ],
      packageDirs,
    );
    expect(selection).toEqual({ groups: [], orphans: [] });
  });

  it("reports a test file no package runs instead of dropping it", () => {
    const selection = selectForkTests(
      ["apps/desktop/src/main.test.ts", "packages/shared/src/agentAwareness.test.tsx"],
      packageDirs,
    );
    expect(selection.orphans).toEqual(["apps/desktop/src/main.test.ts"]);
    expect(selection.groups).toEqual([
      { packageDir: "packages/shared", files: ["src/agentAwareness.test.tsx"] },
    ]);
  });

  it("does not match a package by a shared name prefix", () => {
    const selection = selectForkTests(["scripts-extra/thing.test.ts"], packageDirs);
    expect(selection.orphans).toEqual(["scripts-extra/thing.test.ts"]);
  });
});

it.effect("finds upstream Check when newer suites hide it from the commit endpoint", () =>
  Effect.gen(function* () {
    const checks = yield* upstreamCheckRuns("abc123", (endpoint) => {
      if (endpoint.includes("/actions/workflows/ci.yml/runs?")) {
        return Effect.succeed(JSON.stringify({ head_sha: "abc123", check_suite_id: 42 }));
      }
      if (endpoint.includes("/check-suites/42/check-runs?")) {
        return Effect.succeed(
          JSON.stringify({
            name: "Check",
            status: "completed",
            conclusion: "success",
            app: "github-actions",
          }),
        );
      }
      return Effect.succeed("");
    });
    expect(hasPassedCheck(checks)).toBe(true);
  }),
);

it.effect("rejects a passing workflow on another commit", () =>
  Effect.gen(function* () {
    const checks = yield* upstreamCheckRuns("abc123", () =>
      Effect.succeed(JSON.stringify({ head_sha: "different", check_suite_id: 42 })),
    );
    expect(hasPassedCheck(checks)).toBe(false);
  }),
);

it.effect.each(["failure", "cancelled", null])("rejects a Check with conclusion %s", (conclusion) =>
  Effect.gen(function* () {
    const checks = yield* upstreamCheckRuns("abc123", (endpoint) =>
      Effect.succeed(
        JSON.stringify(
          endpoint.includes("/actions/workflows/")
            ? { head_sha: "abc123", check_suite_id: 42 }
            : { name: "Check", status: "completed", conclusion, app: "github-actions" },
        ),
      ),
    );
    expect(hasPassedCheck(checks)).toBe(false);
  }),
);

it.effect("rejects missing CI and propagates lookup failures", () =>
  Effect.gen(function* () {
    expect(hasPassedCheck(yield* upstreamCheckRuns("abc123", () => Effect.succeed("")))).toBe(
      false,
    );
    const error = new ForkCheckError({ detail: "API unavailable" });
    expect(yield* upstreamCheckRuns("abc123", () => Effect.fail(error)).pipe(Effect.flip)).toBe(
      error,
    );
  }),
);
