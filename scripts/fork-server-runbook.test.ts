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

const section = (heading: string): string => {
  const start = runbook.indexOf(`## ${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
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

  it("states each platform's verification scope under the owner decision of 2026-10-06", () => {
    const scope = section("Verification scope");
    expect(scope).toMatch(/owner decision\s+of 2026-10-06/);
    expect(scope).toMatch(/\*\*Linux x64 server\*\*: runtime-verified\./);
    expect(scope).toMatch(
      /\*\*Mac arm64 desktop app\*\* and \*\*Android arm64-v8a APK\*\*: build-checked but\s+runtime-unverified\./,
    );
    expect(scope).toMatch(/`ADMISSION\.json` names the version and the\s+archive's sha256/);
    expect(scope).toMatch(/`manifest\.json` records this as `verificationScope`/);
  });

  it("shows how to read a release's scope, and who gives the evidence verdict", () => {
    const scope = section("Verification scope");
    expect(scope).toMatch(
      /gh release download v[^\s]+ --repo atlitech\/t3code -p manifest\.json -p ADMISSION\.json\n/,
    );
    expect(scope).toMatch(
      /node scripts\/fork-release-scope\.ts --manifest manifest\.json --admission ADMISSION\.json\n/,
    );
    expect(scope).toMatch(
      /evidence verdict is an independent reader's run on the published release/,
    );
    expect(section("Cutting a release")).toMatch(/\[verification scope\]\(#verification-scope\)/);
  });

  it("gives the operator's t3 recover steps and where points and displaced databases live", () => {
    const rollback = section("Rolling back to an official version");
    const recover = rollback.slice(rollback.indexOf("### Recovering a failed update\n"));
    expect(recover).toMatch(/recovery point under\s+`~\/\.t3\/recovery\/points\/`/);
    expect(recover).toMatch(/1\. List the points[\s\S]*\n\s+t3 recover --list\n/);
    expect(recover).toMatch(/2\. Restore it by its id[\s\S]*\n\s+t3 recover <id>\n/);
    expect(recover).toMatch(/3\. Check the result[\s\S]*`t3 --version`/);
    expect(recover).toMatch(/kept under\s+`~\/\.t3\/recovery\/displaced\/` and never\s+pruned/);
    expect(recover).toMatch(/\[recovery drill\]\(#recovery-drill\)/);
  });

  it("shows how to dispatch the recovery drill and read its records", () => {
    const drill = section("Recovery drill");
    expect(drill).toMatch(/\[recovering a failed update\]\(#recovering-a-failed-update\)/);
    expect(drill).toMatch(
      /gh workflow run fork-recovery-drill\.yml --repo atlitech\/t3code --ref atli\n/,
    );
    expect(drill).toMatch(/--ref atli -f target-version=[^\s]+\n/);
    expect(drill).toMatch(/`priorVersion` in the target's\s+`ADMISSION\.json`/);
    expect(drill).toMatch(/must already\s+carry\s+`t3 recover`/);
    expect(drill).toMatch(
      /gh run download <run-id> --repo atlitech\/t3code -n recovery-drill -n recovery-verification\n/,
    );
    expect(drill).toMatch(/`RECOVERY\.json`/);
    expect(drill).toMatch(
      /The verdict is\s+`VERIFICATION\.json` from the verify\s+job, never the\s+drill job's own grading/,
    );
  });
});
