#!/usr/bin/env node

// Fork-only (atlitech/t3code). Checks the Mac app inside the DMG that
// fork-server-release.yml builds before the workflow uploads it: the bundle
// identifier is the desktop app's, the version is the release's, and the app
// carries no Developer ID signature, because the fork ships it unsigned and the
// owner signs the installed app ad hoc. The workflow hands over the app's
// Info.plist as XML (`plutil -convert xml1`) and the output of
// `codesign -dv --verbose=2`. Runbook: docs/operations/fork-server.md.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { DESKTOP_APP_ID } from "./lib/desktop-app-id.ts";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every `<string>` value stored under `key` in an XML property list. */
export const readPlistStrings = (plist: string, key: string): ReadonlyArray<string> =>
  Array.from(
    plist.matchAll(new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<string>([^<]*)</string>`, "g")),
    (match) => match[1]!,
  );

export type MacSignature =
  | { readonly _tag: "Unsigned" }
  | { readonly _tag: "AdHoc" }
  | { readonly _tag: "Signed"; readonly authority: string }
  | { readonly _tag: "Unrecognized" };

/** Reads what signs the app from `codesign -dv --verbose=2` output. */
export const classifyCodesign = (output: string): MacSignature => {
  if (/: code object is not signed at all$/m.test(output)) return { _tag: "Unsigned" };
  const authority = /^Authority=(.+)$/m.exec(output)?.[1];
  if (authority) return { _tag: "Signed", authority };
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1];
  if (team && team !== "not set") return { _tag: "Signed", authority: `team ${team}` };
  if (/^Signature=adhoc$/m.test(output)) return { _tag: "AdHoc" };
  return { _tag: "Unrecognized" };
};

export class MacIdentityError extends Schema.TaggedError<MacIdentityError>()("MacIdentityError", {
  problems: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `The Mac app is not the release's unsigned app: ${this.problems.join(" ")}`;
  }
}

const readOne = (plist: string, key: string, expected: string): string | undefined => {
  const values = readPlistStrings(plist, key);
  if (values.length !== 1) return `Info.plist has ${values.length} ${key} strings, not one.`;
  if (values[0] !== expected) return `${key} is '${values[0]}', not '${expected}'.`;
  return undefined;
};

export const checkMacIdentity = (input: {
  readonly infoPlist: string;
  readonly codesign: string;
  readonly version: string;
}) =>
  Effect.gen(function* () {
    const signature = classifyCodesign(input.codesign);
    const problems = [
      readOne(input.infoPlist, "CFBundleIdentifier", DESKTOP_APP_ID),
      readOne(input.infoPlist, "CFBundleShortVersionString", input.version),
      signature._tag === "Signed"
        ? `the app is signed by '${signature.authority}'; the fork ships it unsigned.`
        : undefined,
      signature._tag === "Unrecognized"
        ? "codesign output names neither an ad hoc signature nor an unsigned app."
        : undefined,
    ].filter((problem): problem is string => problem !== undefined);
    if (problems.length > 0) return yield* new MacIdentityError({ problems });
    return {
      bundleIdentifier: DESKTOP_APP_ID,
      version: input.version,
      signature: signature._tag === "AdHoc" ? "ad hoc" : "unsigned",
    } as const;
  });

const command = Command.make(
  "fork-mac-identity",
  {
    infoPlist: Flag.String("info-plist").pipe(
      Flag.withDescription("The app's Info.plist as XML (plutil -convert xml1)."),
    ),
    codesign: Flag.String("codesign").pipe(
      Flag.withDescription("Output of `codesign -dv --verbose=2 <app>`, stderr included."),
    ),
    // `--version` is the runner's own flag.
    version: Flag.String("release-version").pipe(
      Flag.withDescription("Fork version, for example 0.0.46-atli.1."),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const identity = yield* checkMacIdentity({
        infoPlist: yield* fs.readFileString(options.infoPlist),
        codesign: yield* fs.readFileString(options.codesign),
        version: options.version,
      });
      yield* Effect.log(
        `${identity.bundleIdentifier} ${identity.version}, ${identity.signature}: the release's app.`,
      );
    }),
).pipe(
  Command.withDescription("Check the fork Mac app's bundle identifier, version and signature."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
