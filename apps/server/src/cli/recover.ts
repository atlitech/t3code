import { HostProcessIsExecutable, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as BootService from "../cloud/bootService.ts";
import {
  isPinnedRuntimeInstalled,
  pinnedRuntimePaths,
  pinnedRuntimeVersionsDir,
} from "../cloud/pinnedRuntime.ts";
import {
  acquireRecoverLock,
  appendRecoveryAction,
  discardPreparedRestore,
  displaceDatabase,
  listRecoveryPoints,
  loadRecoveryPoint,
  prepareRestore,
  restoreSnapshot,
  returnDisplacedDatabase,
  verifySnapshot,
} from "../cloud/recoveryPoint.ts";
import * as ProcessRunner from "../processRunner.ts";
import { isProcessAlive, readPersistedServerRuntimeStateStrict } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";
import { findForegroundServer, repointLauncher, resolveLauncherPath } from "./update.ts";

export class CliRecoverError extends Schema.TaggedError<CliRecoverError>()("CliRecoverError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const recoverFlags = {
  ...projectLocationFlags,
  list: Flag.Boolean("list").pipe(
    Flag.withDescription("List this T3 home's recovery points, newest first."),
    Flag.withDefault(false),
  ),
  allowUnverifiedRuntime: Flag.Boolean("allow-unverified-runtime").pipe(
    Flag.withDescription(
      "Restore a point whose prior runtime has no recorded archive sha256. The point's record keeps that this was allowed.",
    ),
    Flag.withDefault(false),
  ),
};

const idArgument = Argument.String("id").pipe(
  Argument.withDescription("The recovery point to restore, as `t3 recover --list` names it."),
  Argument.optional,
);

export const recoverCommand = Command.make("recover", {
  ...recoverFlags,
  id: idArgument,
}).pipe(
  Command.withDescription(
    "Restore the database and prior t3 runtime a server update kept as a recovery point, keeping the current database aside.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runRecover({
        baseDir: config.baseDir,
        serverRuntimeStatePath: config.serverRuntimeStatePath,
        dbPath: config.dbPath,
        list: flags.list,
        id: Option.getOrUndefined(flags.id),
        allowUnverifiedRuntime: flags.allowUnverifiedRuntime,
        serviceForVersion: (cliVersion) =>
          BootService.layer({ baseDir: config.baseDir, logsDir: config.logsDir, cliVersion }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(CliService.layer(config), ProcessRunner.layer, FetchHttpClient.layer),
        ),
      );
    }),
  ),
);

const refuse = (reason: string) => new CliRecoverError({ reason });

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const listPoints = Effect.fn("cli.recover.list")(function* (baseDir: string) {
  const points = yield* listRecoveryPoints(baseDir).pipe(
    Effect.mapError((error) => refuse(error.message)),
  );
  if (points.length === 0) {
    yield* Console.log(`No recovery points in ${baseDir}.`);
    return;
  }
  for (const point of points) {
    const { record } = point;
    yield* Console.log(
      `${point.id}  ${record.createdAt}  ${record.from.version} -> ${record.to.version}  ${
        record.from.archiveSha256 === null
          ? "no runtime digest recorded"
          : "runtime digest recorded"
      }`,
    );
  }
});

/**
 * `t3 recover`: lists recovery points, or restores one. A restore holds this
 * home's recover lock from its first check to its last step, so a second
 * `t3 recover` refuses meanwhile. Every check runs before anything stops or
 * moves. When this home's service serves it, the service is stopped, the
 * database swapped, and the service pointed at and restarted on the prior
 * runtime; otherwise only the database and launcher change. The restored
 * database keeps every revocation the current one records, and revokes every
 * session and pairing link it no longer has. `serviceForVersion` builds the
 * service that installs and restarts on the point's prior version.
 */
export const runRecover = Effect.fn("cli.recover.run")(function* (input: {
  readonly baseDir: string;
  readonly serverRuntimeStatePath: string;
  readonly dbPath: string;
  readonly list: boolean;
  readonly id: string | undefined;
  readonly allowUnverifiedRuntime: boolean;
  readonly serviceForVersion: (cliVersion: string) => ReturnType<typeof BootService.layer>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const service = yield* BootService.BootService;

  if (input.list) {
    if (input.id !== undefined) {
      return yield* refuse("Pass either --list or a recovery point id, not both.");
    }
    return yield* listPoints(input.baseDir);
  }
  if (input.id === undefined) {
    return yield* refuse(
      "Name the recovery point to restore: `t3 recover <id>`. `t3 recover --list` shows them.",
    );
  }
  const id = input.id;
  yield* acquireRecoverLock(input.baseDir).pipe(Effect.mapError((error) => refuse(error.message)));

  const point = yield* loadRecoveryPoint(input.baseDir, id).pipe(
    Effect.mapError((error) => refuse(error.message)),
  );
  const from = point.record.from;
  if (!(yield* verifySnapshot(point).pipe(Effect.mapError((error) => refuse(error.message))))) {
    return yield* refuse(
      `The snapshot in recovery point ${id} does not match the sha256 its recovery.json records; nothing was changed.`,
    );
  }
  const installed = (admittedArchiveSha256?: string) =>
    isPinnedRuntimeInstalled({
      fs,
      path,
      baseDir: input.baseDir,
      version: from.version,
      platform,
      admittedArchiveSha256,
    });
  if (!(yield* installed())) {
    return yield* refuse(
      `The prior runtime t3@${from.version} is missing from ${pinnedRuntimeVersionsDir(path, input.baseDir)}; nothing was changed.`,
    );
  }
  if (from.archiveSha256 !== null) {
    if (!(yield* installed(from.archiveSha256))) {
      return yield* refuse(
        `The installed t3@${from.version} runtime's archive sha256 differs from the one recovery point ${id} records; nothing was changed.`,
      );
    }
  } else if (!input.allowUnverifiedRuntime) {
    return yield* refuse(
      `Recovery point ${id} records no archive sha256 for t3@${from.version}, so its runtime cannot be verified. Pass --allow-unverified-runtime to restore it anyway.`,
    );
  }

  // Whether a server runs on this home is read from its runtime state; one
  // that cannot be read or decoded leaves that unknown, so recover refuses.
  const readRuntimeState = readPersistedServerRuntimeStateStrict(input.serverRuntimeStatePath);
  const unknownServer = (detail: string) =>
    `Not recovering: cannot tell whether a server is running on this T3 home. ${detail} Once no server is running, remove ${input.serverRuntimeStatePath} and run t3 recover again.`;
  const runtimeState = yield* readRuntimeState.pipe(
    Effect.mapError((error) => refuse(unknownServer(`${error.message} Nothing was changed.`))),
  );

  const status = yield* service.status.pipe(Effect.mapError((error) => refuse(error.message)));
  const servesThisHome =
    status.supported &&
    status.installed &&
    status.installedBaseDir !== undefined &&
    path.resolve(status.installedBaseDir) === path.resolve(input.baseDir);
  const foreground = yield* findForegroundServer({
    serverRuntimeStatePath: input.serverRuntimeStatePath,
    serviceInstalled: servesThisHome,
  });
  if (foreground !== undefined) {
    return yield* refuse(
      `A server started by hand is running on this T3 home at ${foreground.origin} (pid ${foreground.pid}). Stop it, then run t3 recover again.`,
    );
  }
  // A service-managed server is only stopped here when the service serves
  // this home; one still running without such a unit would keep the
  // database open under the swap.
  if (!servesThisHome && Option.isSome(runtimeState) && isProcessAlive(runtimeState.value.pid)) {
    return yield* refuse(
      `A server is running on this T3 home at ${runtimeState.value.origin} (pid ${runtimeState.value.pid}) and no background service for this home can stop it. Stop it, then run t3 recover again.`,
    );
  }

  // Before the swap a record that cannot be written refuses, since nothing
  // has moved yet.
  const record = (action: string, extra?: { readonly allowUnverifiedRuntime?: boolean }) =>
    Console.log(`  ${action}`).pipe(
      Effect.andThen(appendRecoveryAction(input.baseDir, id, action, extra)),
      Effect.mapError((error) => refuse(error.message)),
    );
  // After the swap the restored database stays and the remaining steps still
  // run: an action that cannot be recorded is only warned about.
  const recordAfterSwap = (action: string) =>
    Console.log(`  ${action}`).pipe(
      Effect.andThen(appendRecoveryAction(input.baseDir, id, action)),
      Effect.catch((error) =>
        Console.error(
          `  Warning: could not record this action in ${path.join(point.dir, "recovery.json")}: ${error.message}`,
        ),
      ),
      Effect.asVoid,
    );

  // Once the service is asked to stop, recovery runs to its own end: an
  // interrupt (SIGINT or SIGTERM) waits for it, so the home is never left
  // with the service stopped, the database half swapped, or the service
  // still on the newer runtime.
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      yield* Console.log(
        `Recovering ${input.baseDir} to t3@${from.version} from recovery point ${id}.`,
      );
      if (from.archiveSha256 === null) {
        yield* record(
          `allowed the unverified runtime t3@${from.version} (--allow-unverified-runtime)`,
          {
            allowUnverifiedRuntime: true,
          },
        );
      }

      if (servesThisHome) {
        const stopped = yield* service.stop.pipe(
          Effect.mapError((error) =>
            refuse(`Not recovering: the background service could not be stopped. ${error.message}`),
          ),
        );
        if (!stopped) {
          return yield* refuse(
            "Not recovering: the background service for this T3 home could not be stopped; nothing was changed.",
          );
        }
        // The service manager reporting a stop is not proof the server let go of
        // the database; a server still recorded alive here would keep it open.
        const afterStop = yield* readRuntimeState.pipe(
          Effect.mapError((error) =>
            refuse(
              unknownServer(
                `${error.message} The database was not moved. The background service is stopped.`,
              ),
            ),
          ),
        );
        if (Option.isSome(afterStop) && isProcessAlive(afterStop.value.pid)) {
          return yield* refuse(
            `Not recovering: the background service reported stopped but a server is still running on this T3 home (pid ${afterStop.value.pid}); the database was not moved. Stop that process, then run t3 recover again.`,
          );
        }
        yield* record("stopped the background service").pipe(
          Effect.mapError((error) =>
            refuse(
              `${error.message} The database was not moved. The background service is stopped; run \`t3 service restart\` to start it again.`,
            ),
          ),
        );
      }

      const stoppedNote = servesThisHome
        ? " The background service is stopped; run `t3 service restart` to start it again."
        : "";
      // Only a database fully back in place may be served again.
      const leftStoppedNote = servesThisHome
        ? " The background service is stopped; leave it stopped until then."
        : "";
      // The restored database is prepared beside the live one before anything
      // moves: a copy of the snapshot that takes every revocation the current
      // database records, so a session revoked after the point stays revoked.
      // A copy that cannot be prepared refuses with the live database in place.
      const prepared = yield* prepareRestore(input.baseDir, id, input.dbPath).pipe(
        Effect.mapError((error) =>
          refuse(`Not recovering: ${error.message} The database was not moved.${stoppedNote}`),
        ),
      );

      // The swap is one step: the prepared database is renamed into place
      // right after the live database moves aside, and a failed rename moves
      // that database back, so the home is never left without a database.
      const displacedDir = yield* Effect.gen(function* () {
        const target = yield* displaceDatabase(input.baseDir, input.dbPath, id).pipe(
          Effect.tapError(() => discardPreparedRestore(prepared)),
          Effect.mapError((error) =>
            error._tag === "DatabaseDisplaceError" && !error.rolledBack
              ? refuse(
                  `${error.message} Move ${error.leftDisplaced.map((file) => path.basename(file)).join(", ")} from ${error.displacedDir} back to ${path.dirname(input.dbPath)} before starting any server.${leftStoppedNote}`,
                )
              : refuse(`${error.message}${stoppedNote}`),
          ),
        );
        yield* restoreSnapshot(prepared, input.dbPath).pipe(
          Effect.catch((restoreError) =>
            returnDisplacedDatabase(target, input.dbPath).pipe(
              Effect.matchEffect({
                onSuccess: () =>
                  Effect.fail(
                    refuse(
                      `${restoreError.message} The current database was moved back to ${input.dbPath}; nothing was changed.${stoppedNote}`,
                    ),
                  ),
                onFailure: (returnError) =>
                  Effect.fail(
                    refuse(
                      returnError._tag === "DatabaseReturnError"
                        ? `${restoreError.message} Moving the current database back also failed: ${returnError.message} Move ${returnError.leftDisplaced.map((file) => path.basename(file)).join(", ")} from ${target} back to ${path.dirname(input.dbPath)}${
                            returnError.atLivePath.length === 0
                              ? ""
                              : `, where ${returnError.atLivePath.map((file) => path.basename(file)).join(", ")} already ${returnError.atLivePath.length === 1 ? "is" : "are"},`
                          } before starting any server.${leftStoppedNote}`
                        : `${restoreError.message} Moving the current database back also failed: ${returnError.message} It is kept in ${target}; move ${path.basename(input.dbPath)} and its -wal and -shm from there back to ${path.dirname(input.dbPath)} before starting any server.${leftStoppedNote}`,
                    ),
                  ),
              }),
            ),
          ),
        );
        return target;
      });
      yield* recordAfterSwap(`moved the current database to ${displacedDir}`);
      yield* recordAfterSwap(`restored the database from recovery point ${id}`);
      yield* recordAfterSwap(
        `carried ${counted(prepared.revocations, "revocation")} and ${counted(prepared.usedPairingLinks, "used pairing link")} from the current database${
          prepared.revokedMissing === 0
            ? ""
            : `, and revoked ${counted(prepared.revokedMissing, "session or pairing link")} it no longer has`
        }`,
      );

      // From here on the restored database stays: a step that fails is reported
      // and the remaining steps still run, so the home is never left with the
      // service stopped on the newer runtime.
      const runtime = pinnedRuntimePaths(path, input.baseDir, from.version, platform);
      const launcherFailure = yield* Effect.gen(function* () {
        const launchedAs = (yield* HostProcessIsExecutable)
          ? yield* resolveLauncherPath
          : undefined;
        return yield* repointLauncher({
          launchedAs,
          versionsDir: pinnedRuntimeVersionsDir(path, input.baseDir),
          targetEntryPath: runtime.entryPath,
        });
      }).pipe(
        Effect.matchEffect({
          onSuccess: (repointed) =>
            (Option.isSome(repointed)
              ? recordAfterSwap(`pointed the launcher ${repointed.value} at t3@${from.version}`)
              : Console.log(`  Run ${runtime.entryPath} to start t3@${from.version}.`)
            ).pipe(Effect.as(undefined)),
          onFailure: (error) =>
            Console.error(
              `  Warning: the launcher was not pointed at t3@${from.version}: ${error.message} Run ${runtime.entryPath} to start t3@${from.version}.`,
            ).pipe(Effect.as(error.message)),
        }),
      );

      let serviceFailure: string | undefined;
      if (servesThisHome) {
        const restored = `The database is restored from recovery point ${id} (the replaced one is kept in ${displacedDir}),`;
        serviceFailure = yield* BootService.BootService.pipe(
          Effect.flatMap((target) =>
            target.install({ allowDowngrade: true, start: false }).pipe(
              Effect.mapError(
                (error) =>
                  `${restored} but the background service could not be pointed at t3@${from.version}: ${error.message} It is stopped and still runs the newer version; do not restart it until \`${runtime.entryPath} service install --allow-downgrade --base-dir ${input.baseDir}\` succeeds.`,
              ),
              Effect.tap(() =>
                recordAfterSwap(`pointed the background service at t3@${from.version}`),
              ),
              Effect.andThen(
                target.restart.pipe(
                  Effect.mapError(
                    (error) =>
                      `${restored} and the background service points at t3@${from.version}, but it could not be restarted: ${error.message} Run \`t3 service restart\`.`,
                  ),
                ),
              ),
            ),
          ),
          Effect.provide(input.serviceForVersion(from.version)),
          Effect.flatMap((restarted) =>
            restarted
              ? recordAfterSwap(`restarted the background service on t3@${from.version}`).pipe(
                  Effect.as(undefined),
                )
              : Effect.succeed(
                  `${restored} and the background service points at t3@${from.version}, but it was not restarted. Run \`t3 service restart\`.`,
                ),
          ),
          Effect.catch((reason) =>
            Effect.succeed(
              typeof reason === "string"
                ? reason
                : `${restored} but the background service could not be moved to t3@${from.version}: ${reason.message}`,
            ),
          ),
        );
      } else if (status.installed && status.installedBaseDir !== undefined) {
        yield* Console.log(
          `  The background service serves ${status.installedBaseDir} and was left unchanged.`,
        );
      }

      if (launcherFailure !== undefined) {
        const launcherNote = `the launcher could not be pointed at t3@${from.version}: ${launcherFailure} Run ${runtime.entryPath} to start t3@${from.version}.`;
        return yield* refuse(
          serviceFailure !== undefined
            ? `${serviceFailure} Also, ${launcherNote}`
            : servesThisHome
              ? `The database and the background service are on t3@${from.version}, but ${launcherNote}`
              : `The database is restored from recovery point ${id}, but ${launcherNote}`,
        );
      }
      if (serviceFailure !== undefined) return yield* refuse(serviceFailure);
      yield* Console.log(`Recovered to t3@${from.version}.`);
    }),
  );
}, Effect.scoped);
