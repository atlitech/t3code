import { assert, it } from "@effect/vitest";

import type { PublishedRelease } from "../linux-admission/prior-release.ts";
import { selectDrillTarget } from "./drill-target.ts";

const release = (version: string, extra: ReadonlyArray<string> = []): PublishedRelease => ({
  tagName: `v${version}`,
  draft: false,
  assets: [`t3-${version}-linux-x64.tar.gz`, "SHA256SUMS", ...extra],
});
const admitted = (version: string) => release(version, ["ADMISSION.json"]);

const releases = [
  admitted("0.0.46-atli.9"),
  admitted("0.0.46-atli.10"),
  release("0.0.46-atli.11"),
  { ...admitted("0.0.46-atli.12"), draft: true },
  { tagName: "v0.0.46-atli.13", draft: false, assets: ["SHA256SUMS", "ADMISSION.json"] },
  admitted("1.2.3"),
];

it("drills the newest admitted release when none is named", () => {
  assert.deepStrictEqual(selectDrillTarget({ releases, requested: "" }), {
    _tag: "Selected",
    version: "0.0.46-atli.10",
  });
  assert.deepStrictEqual(selectDrillTarget({ releases, requested: "  " }), {
    _tag: "Selected",
    version: "0.0.46-atli.10",
  });
});

it("drills a named admitted release", () => {
  assert.deepStrictEqual(selectDrillTarget({ releases, requested: "0.0.46-atli.9" }), {
    _tag: "Selected",
    version: "0.0.46-atli.9",
  });
});

it("refuses a name that is not a fork version", () => {
  for (const requested of ["1.2.3", "v0.0.46-atli.9", "0.0.46-atli"]) {
    const decision = selectDrillTarget({ releases, requested });
    assert.strictEqual(decision._tag, "Refused");
    if (decision._tag === "Refused") assert.strictEqual(decision.reason, "invalid_version");
  }
});

it("refuses a named release that is not admitted, is a draft, or lacks its archive", () => {
  for (const requested of ["0.0.46-atli.11", "0.0.46-atli.12", "0.0.46-atli.13", "0.0.47-atli.1"]) {
    const decision = selectDrillTarget({ releases, requested });
    assert.strictEqual(decision._tag, "Refused");
    if (decision._tag === "Refused") assert.strictEqual(decision.reason, "not_admitted");
  }
});

it("refuses when no release was admitted", () => {
  const decision = selectDrillTarget({ releases: [release("0.0.46-atli.1")], requested: "" });
  assert.strictEqual(decision._tag, "Refused");
  if (decision._tag === "Refused") assert.strictEqual(decision.reason, "no_admitted_release");
});
