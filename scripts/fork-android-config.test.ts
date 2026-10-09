// @effect-diagnostics nodeBuiltinImport:off - Reads the committed resolved-config fixture.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkAndroidConfig, readPath } from "./fork-android-config.ts";

// Fixture: `APP_VARIANT=personal vp exec expo config --type public --json`,
// run in apps/mobile with dummy public values (T3CODE_RELAY_URL=
// https://relay.example.test, T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example,
// T3CODE_CLERK_JWT_TEMPLATE=example) and no Google values. Each variant below
// mutates a fresh parse of it.
const resolved = (): Record<string, any> =>
  JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(
        import.meta.dirname,
        "fixtures",
        "fork-android-config",
        "expo-config-personal.json",
      ),
      "utf8",
    ),
  );

it("reads nested values and stops where the path breaks", () => {
  const config = resolved();
  assert.strictEqual(readPath(config, ["extra", "relay", "url"]), "https://relay.example.test");
  assert.strictEqual(readPath(config, ["android", "package"]), "com.elvis.t3code");
  assert.isUndefined(readPath(config, ["extra", "relay", "url", "host"]));
  assert.isUndefined(readPath(config, ["missing", "path"]));
});

it.effect("accepts the resolved personal config without the optional Google values", () =>
  Effect.gen(function* () {
    const config = resolved();
    assert.isUndefined(config.extra.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID);
    assert.isUndefined(config.android.googleServicesFile);
    assert.deepStrictEqual(yield* checkAndroidConfig(config), {
      androidPackage: "com.elvis.t3code",
      googleSignIn: false,
      googleServices: false,
    });
  }),
);

it.effect("accepts it with native Google sign-in and google-services.json", () =>
  Effect.gen(function* () {
    const config = resolved();
    config.extra.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID = "example.apps.googleusercontent.com";
    config.android.googleServicesFile = "/runner/temp/google-services.json";
    assert.deepStrictEqual(yield* checkAndroidConfig(config), {
      androidPackage: "com.elvis.t3code",
      googleSignIn: true,
      googleServices: true,
    });
  }),
);

it.effect("refuses a missing relay URL or Clerk identifier, one problem each", () =>
  Effect.gen(function* () {
    // `expo config --type public` writes an unset value as `{}`.
    const mutations: ReadonlyArray<(config: Record<string, any>) => void> = [
      (config) => (config.extra.relay.url = {}),
      (config) => (config.extra.relay.url = ""),
      (config) => delete config.extra.relay,
      (config) => (config.extra.clerk.publishableKey = {}),
      (config) => (config.extra.clerk.publishableKey = null),
      (config) => (config.extra.clerk.jwtTemplate = {}),
      (config) => (config.extra.clerk.jwtTemplate = "  "),
      (config) => (config.android.package = "com.t3tools.t3code"),
      (config) => delete config.android,
    ];
    for (const mutate of mutations) {
      const config = resolved();
      mutate(config);
      const error = yield* Effect.flip(checkAndroidConfig(config));
      assert.strictEqual(error._tag, "AndroidConfigError");
      assert.strictEqual(error.problems.length, 1, error.message);
    }
  }),
);

it.effect("names every missing value at once", () =>
  Effect.gen(function* () {
    const config = resolved();
    config.extra.relay.url = {};
    config.extra.clerk = { publishableKey: {}, jwtTemplate: {} };
    const error = yield* Effect.flip(checkAndroidConfig(config));
    assert.deepStrictEqual(error.problems, [
      "extra.relay.url is not set.",
      "extra.clerk.publishableKey is not set.",
      "extra.clerk.jwtTemplate is not set.",
    ]);
  }),
);
