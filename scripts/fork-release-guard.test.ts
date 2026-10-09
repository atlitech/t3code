import { describe, expect, it } from "vite-plus/test";

import {
  decideRelease,
  formatGitHubOutput,
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
