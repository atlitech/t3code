// @effect-diagnostics nodeBuiltinImport:off - Reads the committed CI workflows as text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// The fork does not run upstream's CI. fork-ci.yml's `Check` runs on pull
// requests into atli and pushes to atli, on GitHub-hosted runners: it confirms
// the upstream commit passed upstream's CI and runs the fork's own tests. The
// push run is the `Check` fork-server-release.yml requires on the commit it
// releases, and the release also runs fork-full-suite.yml.
const read = (file: string) =>
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "..", ".github", "workflows", file),
    "utf8",
  );
const workflow = read("fork-ci.yml");
const fullSuite = read("fork-full-suite.yml");
const lines = workflow.split("\n");

const triggerBranches = (event: "pull_request" | "push"): ReadonlyArray<string> => {
  const start = lines.indexOf(`  ${event}:`);
  expect(start).toBeGreaterThan(-1);
  const block: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^ {4}/.test(line)) break;
    block.push(line);
  }
  const branchesAt = block.indexOf("    branches:");
  expect(branchesAt).toBeGreaterThan(-1);
  return block
    .slice(branchesAt + 1)
    .map((line) => /^ {6}- (\S+)\s*$/.exec(line)?.[1])
    .filter((branch): branch is string => branch !== undefined);
};

const runners = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/^ {4}runs-on:\s*(\S+)\s*$/gm)].map((match) => match[1]!);

describe("fork CI workflow", () => {
  it("runs on pull requests into atli only", () => {
    expect(triggerBranches("pull_request")).toEqual(["atli"]);
  });

  it("runs on pushes to atli only", () => {
    expect(triggerBranches("push")).toEqual(["atli"]);
  });

  it("names the job the atli ruleset and fork-server-release.yml require Check", () => {
    expect(workflow).toMatch(/^ {2}check:\n {4}name: Check\n/m);
  });

  it("checks out history so the fork check can find the upstream commit", () => {
    expect(workflow).toMatch(/fetch-depth: 0\n\s+filter: blob:none/);
  });

  it("runs the fork check, lint, and typecheck", () => {
    expect(workflow).toMatch(/run: node scripts\/fork-check\.ts\n/);
    expect(workflow).toMatch(/run: vp check\n/);
    expect(workflow).toMatch(/run: vpr typecheck\n/);
  });

  it("runs every fork CI job on a GitHub-hosted Ubuntu runner", () => {
    for (const text of [workflow, fullSuite]) {
      const found = runners(text);
      expect(found.length).toBeGreaterThan(0);
      for (const runner of found) expect(runner).toMatch(/^ubuntu-\d{2}\.\d{2}$/);
    }
  });
});
