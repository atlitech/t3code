// @effect-diagnostics nodeBuiltinImport:off - Reads the committed CI workflow as text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// The fork runs upstream's CI on pull requests into atli, on GitHub-hosted
// runners only: the fork has no Blacksmith installation.
const workflow = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"),
  "utf8",
);
const lines = workflow.split("\n");

const jobRunners = (): ReadonlyMap<string, string> => {
  const runners = new Map<string, string>();
  let job: string | undefined;
  let inJobs = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inJobs = line === "jobs:";
      job = undefined;
      continue;
    }
    const jobMatch = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line) : null;
    if (jobMatch) {
      job = jobMatch[1];
      continue;
    }
    const runsOn = /^ {4}runs-on:\s*(\S+)\s*$/.exec(line);
    if (job && runsOn) runners.set(job, runsOn[1]!);
  }
  return runners;
};

const pullRequestBranches = (): ReadonlyArray<string> => {
  const start = lines.indexOf("  pull_request:");
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

describe("fork CI workflow", () => {
  it("runs on pull requests into atli only", () => {
    expect(pullRequestBranches()).toEqual(["atli"]);
  });

  it("names no Blacksmith runner", () => {
    expect(workflow).not.toMatch(/runs-on:.*blacksmith/);
  });

  it("runs every job on a GitHub-hosted runner, the native lint on macOS", () => {
    const runners = jobRunners();
    expect(runners.size).toBeGreaterThan(0);
    expect(runners.get("check")).toBeDefined();
    for (const [job, runner] of runners) {
      if (job === "mobile_native_static_analysis") {
        expect(runner).toMatch(/^macos-\d+$/);
      } else {
        expect(runner, job).toMatch(/^ubuntu-\d{2}\.\d{2}$/);
      }
    }
    expect(runners.get("mobile_native_static_analysis")).toBeDefined();
  });
});
