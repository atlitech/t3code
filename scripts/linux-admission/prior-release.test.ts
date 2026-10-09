import { assert, it } from "@effect/vitest";

import { compareVersions, type PublishedRelease, selectPriorRelease } from "./prior-release.ts";

const release = (version: string, extra: ReadonlyArray<string> = []): PublishedRelease => ({
  tagName: `v${version}`,
  draft: false,
  assets: [`t3-${version}-linux-x64.tar.gz`, "SHA256SUMS", ...extra],
});
const admitted = (version: string) => release(version, ["manifest.json", "ADMISSION.json"]);

it("orders fork versions numerically", () => {
  assert.isBelow(compareVersions("0.0.46-atli.9", "0.0.46-atli.10"), 0);
  assert.isBelow(compareVersions("0.0.46-atli.10", "0.0.47-atli.1"), 0);
  assert.strictEqual(compareVersions("0.0.46-atli.3", "0.0.46-atli.3"), 0);
});

it("upgrades from the newest earlier admitted release", () => {
  const decision = selectPriorRelease({
    releases: [
      admitted("0.0.46-atli.9"),
      admitted("0.0.46-atli.10"),
      release("0.0.46-atli.11"),
      admitted("0.0.46-atli.13"),
      { ...admitted("0.0.46-atli.12"), draft: true },
    ],
    candidateVersion: "0.0.46-atli.12",
    bootstrap: "",
  });
  assert.deepStrictEqual(decision, {
    _tag: "Selected",
    version: "0.0.46-atli.10",
    source: "admitted",
  });
});

it("skips an admitted release whose archive or SHA256SUMS is missing", () => {
  const decision = selectPriorRelease({
    releases: [
      admitted("0.0.46-atli.4"),
      { tagName: "v0.0.46-atli.5", draft: false, assets: ["ADMISSION.json", "SHA256SUMS"] },
    ],
    candidateVersion: "0.0.46-atli.6",
    bootstrap: "",
  });
  assert.deepStrictEqual(decision, {
    _tag: "Selected",
    version: "0.0.46-atli.4",
    source: "admitted",
  });
});

it("refuses the first admission unless the owner names the prior release", () => {
  const releases = [release("0.0.46-atli.2"), release("0.0.46-atli.3")];
  const refused = selectPriorRelease({
    releases,
    candidateVersion: "0.0.46-atli.4",
    bootstrap: "",
  });
  assert.strictEqual(refused._tag === "Refused" && refused.reason, "no_admitted_release");

  const bootstrapped = selectPriorRelease({
    releases,
    candidateVersion: "0.0.46-atli.4",
    bootstrap: "0.0.46-atli.3",
  });
  assert.deepStrictEqual(bootstrapped, {
    _tag: "Selected",
    version: "0.0.46-atli.3",
    source: "bootstrap",
  });
});

it("refuses a bootstrap that is not an earlier installable release", () => {
  const releases = [release("0.0.46-atli.3"), release("0.0.46-atli.5")];
  for (const bootstrap of ["0.0.46-atli.2", "0.0.46-atli.5", "0.0.46-atli.4", "latest"]) {
    const decision = selectPriorRelease({
      releases,
      candidateVersion: "0.0.46-atli.4",
      bootstrap,
    });
    assert.strictEqual(
      decision._tag === "Refused" && decision.reason,
      "bootstrap_not_usable",
      bootstrap,
    );
  }
});

it("refuses a bootstrap once a release is admitted", () => {
  const decision = selectPriorRelease({
    releases: [release("0.0.46-atli.3"), admitted("0.0.46-atli.4")],
    candidateVersion: "0.0.46-atli.5",
    bootstrap: "0.0.46-atli.3",
  });
  assert.strictEqual(decision._tag === "Refused" && decision.reason, "bootstrap_not_needed");
});
