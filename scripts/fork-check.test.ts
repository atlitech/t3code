import { describe, expect, it } from "vite-plus/test";

import { selectForkTests } from "./fork-check.ts";

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
