// @effect-diagnostics nodeBuiltinImport:off - Reads committed Info.plist and codesign fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkMacIdentity, classifyCodesign, readPlistStrings } from "./fork-mac-identity.ts";

// Fixtures: an electron-builder Info.plist converted with `plutil -convert
// xml1`, and `codesign -dv --verbose=2` output for an unsigned app, an ad hoc
// signed app, and a Developer ID signed app.
const fixture = (name: string): string =>
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "fixtures", "fork-mac-identity", name),
    "utf8",
  );

const version = "0.0.46-atli.1";
const infoPlist = fixture("Info.plist");
const unsigned = fixture("codesign-unsigned.txt");
const adHoc = fixture("codesign-adhoc.txt");
const developerId = fixture("codesign-developer-id.txt");

it("reads top-level strings from the Info.plist", () => {
  assert.deepStrictEqual(readPlistStrings(infoPlist, "CFBundleIdentifier"), ["com.t3tools.t3code"]);
  assert.deepStrictEqual(readPlistStrings(infoPlist, "CFBundleShortVersionString"), [version]);
  assert.deepStrictEqual(readPlistStrings(infoPlist, "CFBundleMissing"), []);
});

it("tells an unsigned, ad hoc, and Developer ID signed app apart", () => {
  assert.deepStrictEqual(classifyCodesign(unsigned), { _tag: "Unsigned" });
  assert.deepStrictEqual(classifyCodesign(adHoc), { _tag: "AdHoc" });
  assert.deepStrictEqual(classifyCodesign(developerId), {
    _tag: "Signed",
    authority: "Developer ID Application: Example Tools Inc. (ABCDE12345)",
  });
  assert.deepStrictEqual(classifyCodesign("codesign: no such file or directory\n"), {
    _tag: "Unrecognized",
  });
});

it.effect("accepts the release's unsigned or ad hoc signed app", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* checkMacIdentity({ infoPlist, codesign: unsigned, version }), {
      bundleIdentifier: "com.t3tools.t3code",
      version,
      signature: "unsigned",
    });
    const signedAdHoc = yield* checkMacIdentity({ infoPlist, codesign: adHoc, version });
    assert.strictEqual(signedAdHoc.signature, "ad hoc");
  }),
);

it.effect("refuses a wrong bundle identifier, version, or signature", () =>
  Effect.gen(function* () {
    const refused = [
      {
        infoPlist: infoPlist.replace("com.t3tools.t3code", "com.github.Electron"),
        codesign: unsigned,
        version,
      },
      { infoPlist, codesign: unsigned, version: "0.0.46-atli.2" },
      { infoPlist, codesign: developerId, version },
      { infoPlist, codesign: "codesign: no such file or directory\n", version },
      {
        infoPlist: infoPlist.replace(/<key>CFBundleShortVersionString<\/key>/, ""),
        codesign: unsigned,
        version,
      },
    ];
    for (const input of refused) {
      const error = yield* Effect.flip(checkMacIdentity(input));
      assert.strictEqual(error._tag, "MacIdentityError");
      assert.strictEqual(error.problems.length, 1, error.message);
    }
  }),
);
