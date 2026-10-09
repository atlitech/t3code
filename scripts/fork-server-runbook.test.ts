// @effect-diagnostics nodeBuiltinImport:off - Reads the committed fork runbook as text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// atli takes upstream changes only through a merge-commit candidate pull
// request: its ruleset refuses force pushes, so the runbook never rebases it.
const runbook = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", "docs", "operations", "fork-server.md"),
  "utf8",
);

const updateSection = (): string => {
  const start = runbook.indexOf("## Updating `atli` from upstream\n");
  expect(start).toBeGreaterThan(-1);
  const rest = runbook.slice(start + 1);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
};

describe("fork server runbook", () => {
  it("never rebases or force-pushes", () => {
    expect(runbook).not.toMatch(/git\s+rebase/);
    expect(runbook).not.toMatch(/--force-with-lease/);
    expect(runbook).not.toMatch(/git\s+push\b[^\n]*(--force|\s-f\b)/);
  });

  it("merges a frozen upstream commit through a candidate pull request", () => {
    const section = updateSection();
    expect(section).toMatch(/upstream_sha="\$\(git rev-parse upstream\/main\)"/);
    expect(section).toMatch(/git switch -c "\$branch" origin\/atli/);
    expect(section).toMatch(/git merge --no-ff "\$upstream_sha"/);
    expect(section).toMatch(/gh pr create [^\n]*--base atli/);
  });

  it("merges the candidate pull request with a merge commit", () => {
    const section = updateSection();
    expect(section).toMatch(/merge the pull request with a merge commit, never\s+squash or rebase/);
    expect(section).toMatch(/gh pr merge [^\n]*--merge\b/);
    expect(section).not.toMatch(/--squash|--rebase/);
  });

  it("names the known conflict resolutions and stops on any other", () => {
    const section = updateSection();
    expect(section).toMatch(
      /`pnpm-workspace\.yaml`[\s\S]*`patchedDependencies`[\s\S]*Keep both sides/,
    );
    expect(section).toMatch(/`pnpm-lock\.yaml`: never hand-merge it[\s\S]*`pnpm install`/);
    expect(section).toMatch(/Any other conflict stops the update[\s\S]*for the owner/);
  });

  it("restarts the fork counter when the server version moves", () => {
    expect(runbook).toMatch(/new next patch\s+and restart `<n>` at 1/);
  });
});
