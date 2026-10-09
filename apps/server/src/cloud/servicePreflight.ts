import * as NodeSqlite from "node:sqlite";

import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import { initializeV2Database } from "../persistence/initializeV2Database.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type * as ProcessRunner from "../processRunner.ts";
import {
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  type PinnedRuntimePaths,
  PinnedRuntimePreflightBlockedError,
} from "./pinnedRuntime.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

// Long enough to copy and migrate a large database, short enough that a hung
// runtime does not hold the pinned-runtime install lock forever.
const STAGED_PREFLIGHT_TIMEOUT = Duration.minutes(5);

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

/**
 * The install step a staged runtime fails with when it is a release from
 * before the update preflight and so does not know `__service-preflight`.
 */
export const SERVICE_PREFLIGHT_UNSUPPORTED_STEP =
  "running the staged service preflight (the runtime has no such command)";

// eslint-disable-next-line no-control-regex -- matches the ANSI colour codes a CLI may print.
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

/**
 * Whether a failed preflight run is a CLI that does not know the command. The
 * root `t3` command takes an optional `cwd` argument, so such a CLI reads
 * `__service-preflight` as that directory and rejects the first preflight
 * flag as unknown to the root command; a CLI that knows the command would
 * name it in the command path. A CLI whose root takes no argument reports the
 * subcommand itself as unknown.
 */
const isUnknownPreflightCommand = (result: { readonly code: number; readonly stderr: string }) => {
  if (result.code !== 1) return false;
  const stderr = result.stderr.replace(ANSI_ESCAPE, "");
  return (
    /^\s*Unrecognized flag: --database-path(?: in command t3)?\s*$/m.test(stderr) ||
    /^\s*Unknown subcommand "__service-preflight"/m.test(stderr)
  );
};

const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

// The V1 database initializeV2Database imports from when the V2 database at
// the path it is given does not exist yet; it names the same sibling.
const LEGACY_DATABASE_NAME = "state.sqlite";

/**
 * Copies a SQLite database with its online backup through a read-only
 * connection, so it sees one consistent state of a database a running server
 * is still writing and never writes or checkpoints the live files.
 */
export const snapshotDatabase = (sourcePath: string, destinationPath: string) =>
  Effect.tryPromise(async () => {
    const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
    try {
      await NodeSqlite.backup(database, destinationPath);
    } finally {
      database.close();
    }
  });

/**
 * Runs the server's database initialization on a scratch copy: snapshots the
 * V2 database, or when there is none yet the V1 database next to it, with
 * SQLite's online backup, then imports and opens the copy the way
 * SqlitePersistence.layerConfig does at startup, which runs this build's
 * migrations on it. The backup reads through a read-only connection, so it
 * sees one consistent state of a database the running server is still
 * writing, including commits that so far live only in its -wal, and it never
 * writes or checkpoints the live files; a failed import or migration leaves
 * them as they were. Neither database is a fresh install: nothing to migrate.
 */
const migrateDatabaseCopy = Effect.fn("cloud.service_preflight.migrate_database_copy")(function* (
  databasePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const legacyPath = path.join(path.dirname(databasePath), LEGACY_DATABASE_NAME);
  const source = (yield* fs.exists(databasePath))
    ? { path: databasePath, name: path.basename(databasePath) }
    : (yield* fs.exists(legacyPath))
      ? { path: legacyPath, name: LEGACY_DATABASE_NAME }
      : undefined;
  if (source === undefined) return;
  const scratchDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-preflight-" });
  const scratchPath = path.join(scratchDir, path.basename(databasePath));
  yield* snapshotDatabase(source.path, path.join(scratchDir, source.name));
  // Imports the V1 snapshot into the scratch V2 path; a no-op for a V2 snapshot.
  yield* initializeV2Database(scratchPath);
  // Building the layer opens the copy and runs the migrations; the scope
  // closes the connection before the scratch directory is removed.
  yield* Layer.build(SqlitePersistence.layerFromPath(scratchPath));
}, Effect.scoped);

/**
 * What a staged runtime answers when asked whether it can take over: the
 * launcher protocol it needs, and whether its migrations run on a copy of the
 * existing database. Callers read exactly one JSON line of this from stdout.
 */
export const runServicePreflight = Effect.fn("cloud.service_preflight.run")(function* (input: {
  /** Older servers always pass this flag when invoking a staged preflight. */
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}) {
  const version = input.version ?? packageJson.version;
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    const blocked: ServicePreflightResult = {
      status: "blocked",
      version,
      reason:
        "This release requires a newer T3 Code service launcher. Update it on the server machine.",
    };
    return blocked;
  }
  return yield* migrateDatabaseCopy(input.databasePath).pipe(
    Effect.as<ServicePreflightResult>({
      status: "ready",
      version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    }),
    Effect.catchCause((cause) =>
      Effect.succeed<ServicePreflightResult>({
        status: "blocked",
        version,
        reason: `t3@${version} cannot run on this server's data: migration of a copy of the existing database failed: ${failureMessage(cause)}`,
      }),
    ),
  );
});

function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}

/**
 * Runs `__service-preflight` on a staged runtime against the live database
 * path and fails unless it reports ready for `targetVersion`. A blocked answer
 * surfaces its reason as PinnedRuntimePreflightBlockedError.
 */
export const runStagedServicePreflight = (input: {
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly runtime: PinnedRuntimePaths;
  readonly databasePath: string;
  readonly targetVersion: string;
}): Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError> =>
  input.runner
    .run({
      command: pinnedRuntimeCommand(input.runtime).command,
      args: [
        ...pinnedRuntimeCommand(input.runtime).args,
        "__service-preflight",
        "--database-path",
        input.databasePath,
        "--launcher-protocol",
        String(SERVICE_LAUNCHER_PROTOCOL),
      ],
      timeout: STAGED_PREFLIGHT_TIMEOUT,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({ step: "running the staged service preflight", cause }),
      ),
      Effect.flatMap(
        (
          result,
        ): Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError> => {
          if (result.code !== 0) {
            const code = Number(result.code);
            return Effect.fail(
              new PinnedRuntimeInstallError({
                step: isUnknownPreflightCommand({ code, stderr: result.stderr })
                  ? SERVICE_PREFLIGHT_UNSUPPORTED_STEP
                  : "running the staged service preflight",
                exitCode: code,
                stdoutLength: result.stdout.length,
                stderrLength: result.stderr.length,
              }),
            );
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(result.stdout.trim());
          } catch (cause) {
            return Effect.fail(
              new PinnedRuntimeInstallError({
                step: "decoding the staged service preflight",
                cause,
              }),
            );
          }
          const preflight = decodeServicePreflightResult(parsed);
          if (preflight === undefined || preflight.version !== input.targetVersion) {
            return Effect.fail(
              new PinnedRuntimeInstallError({ step: "verifying the staged service preflight" }),
            );
          }
          return preflight.status === "ready"
            ? Effect.void
            : Effect.fail(
                new PinnedRuntimePreflightBlockedError({
                  version: input.targetVersion,
                  reason: preflight.reason,
                }),
              );
        },
      ),
    );
