import { describe, expect, it } from "vite-plus/test";

import { ANDROID_VERSION_CODE_FLOOR, androidVersionCode } from "./android-version-code.ts";

// Google Play refuses a versionCode above this.
const ANDROID_MAX_VERSION_CODE = 2_100_000_000;

describe("androidVersionCode", () => {
  it("grows strictly with release order, above the floor and below Android's ceiling", () => {
    const releaseOrder = [
      "0.0.0-atli.0",
      "0.0.46-atli.1",
      "0.0.46-atli.2",
      "0.0.46-atli.10",
      "0.0.47-atli.0",
      "0.1.0-atli.0",
      "1.0.0-atli.0",
      "19.99.999-atli.999",
    ];
    const codes = releaseOrder.map(androidVersionCode);

    expect(codes[0]).toBeGreaterThan(ANDROID_VERSION_CODE_FLOOR);
    for (let index = 1; index < codes.length; index += 1) {
      expect(codes[index]).toBeGreaterThan(codes[index - 1]!);
    }
    expect(codes.at(-1)).toBeLessThanOrEqual(ANDROID_MAX_VERSION_CODE);
    expect(codes.every(Number.isSafeInteger)).toBe(true);
  });

  it("encodes each part in its own decimal field", () => {
    expect(androidVersionCode("0.0.46-atli.4")).toBe(46_006);
    expect(androidVersionCode("1.2.3-atli.4")).toBe(102_003_006);
  });

  it("refuses a version outside the fork grammar", () => {
    for (const version of [
      "",
      "0.0.46",
      "0.0.46-atli",
      "0.0.46-beta.1",
      "v0.0.46-atli.1",
      "0.0.046-atli.1",
      "0.0.46-atli.01",
      " 0.0.46-atli.1",
    ]) {
      expect(() => androidVersionCode(version), version).toThrow(/not a fork release version/);
    }
  });

  it("refuses a part the versionCode cannot encode", () => {
    for (const version of [
      "20.0.0-atli.0",
      "0.100.0-atli.0",
      "0.0.1000-atli.0",
      "0.0.0-atli.1000",
    ]) {
      expect(() => androidVersionCode(version), version).toThrow(/cannot encode it/);
    }
  });
});
