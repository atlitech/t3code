#!/usr/bin/env node

// Fork-only (atlitech/t3code). Checks the personal Android app's resolved
// public config before fork-server-release.yml builds the APK from it: the
// personal variant resolved, and the relay URL and Clerk identifiers the app
// signs in with are set. Native Google sign-in and push stay optional. The
// workflow hands over the output of
// `APP_VARIANT=personal expo config --type public --json`, which serializes an
// unset value as `{}`, not null. Runbook: docs/operations/fork-server.md.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

const PERSONAL_ANDROID_PACKAGE = "com.elvis.t3code";

export class AndroidConfigError extends Schema.TaggedError<AndroidConfigError>()(
  "AndroidConfigError",
  {
    problems: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `The personal Android app's public config is incomplete: ${this.problems.join(" ")}`;
  }
}

/** The value at `path` in a parsed config, or undefined where the path breaks. */
export const readPath = (config: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined,
    config,
  );

const readString = (config: unknown, path: ReadonlyArray<string>): string | undefined => {
  const value = readPath(config, path);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

const REQUIRED = [
  ["extra", "relay", "url"],
  ["extra", "clerk", "publishableKey"],
  ["extra", "clerk", "jwtTemplate"],
] as const;

export const checkAndroidConfig = (config: unknown) =>
  Effect.gen(function* () {
    const androidPackage = readString(config, ["android", "package"]);
    const problems = [
      androidPackage === PERSONAL_ANDROID_PACKAGE
        ? undefined
        : `android.package is '${androidPackage ?? ""}', not '${PERSONAL_ANDROID_PACKAGE}'; the personal variant did not resolve.`,
      ...REQUIRED.map((path) =>
        readString(config, path) === undefined ? `${path.join(".")} is not set.` : undefined,
      ),
    ].filter((problem): problem is string => problem !== undefined);
    if (problems.length > 0) return yield* new AndroidConfigError({ problems });
    return {
      androidPackage: PERSONAL_ANDROID_PACKAGE,
      googleSignIn:
        readString(config, ["extra", "EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID"]) !== undefined,
      googleServices: readString(config, ["android", "googleServicesFile"]) !== undefined,
    } as const;
  });

const decodeConfigJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const command = Command.make(
  "fork-android-config",
  {
    config: Flag.String("config").pipe(
      Flag.withDescription(
        "Output of `APP_VARIANT=personal expo config --type public --json`, run in apps/mobile.",
      ),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(options.config);
      const config = yield* decodeConfigJson(text).pipe(
        Effect.mapError(
          () => new AndroidConfigError({ problems: [`'${options.config}' is not JSON.`] }),
        ),
      );
      const checked = yield* checkAndroidConfig(config);
      yield* Effect.log(
        `${checked.androidPackage}: relay URL and Clerk identifiers set; native Google sign-in ${
          checked.googleSignIn ? "on" : "off"
        }, google-services.json ${checked.googleServices ? "on" : "off"}.`,
      );
    }),
).pipe(
  Command.withDescription(
    "Check the personal Android app's resolved public config before a build.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
