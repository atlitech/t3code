import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
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

const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/**
 * Copies the database (with its -wal and -shm, when present) into a scratch
 * directory and opens the copy, which runs this build's migrations on it. The
 * live database is only read, never opened, so a failed migration leaves it
 * byte-identical. A missing database is a fresh install: nothing to migrate.
 */
const migrateDatabaseCopy = Effect.fn("cloud.service_preflight.migrate_database_copy")(function* (
  databasePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(databasePath))) return;
  const scratchDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-preflight-" });
  const scratchPath = path.join(scratchDir, path.basename(databasePath));
  yield* fs.copyFile(databasePath, scratchPath);
  for (const suffix of ["-wal", "-shm"]) {
    if (yield* fs.exists(`${databasePath}${suffix}`)) {
      yield* fs.copyFile(`${databasePath}${suffix}`, `${scratchPath}${suffix}`);
    }
  }
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

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
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
            return Effect.fail(
              new PinnedRuntimeInstallError({
                step: "running the staged service preflight",
                exitCode: Number(result.code),
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
