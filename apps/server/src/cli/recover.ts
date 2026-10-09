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
  appendRecoveryAction,
  displaceDatabase,
  listRecoveryPoints,
  loadRecoveryPoint,
  restoreSnapshot,
  verifySnapshot,
} from "../cloud/recoveryPoint.ts";
import * as ProcessRunner from "../processRunner.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
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
 * `t3 recover`: lists recovery points, or restores one. Every check runs
 * before anything stops or moves. When this home's service serves it, the
 * service is stopped, the database swapped, and the service pointed at and
 * restarted on the prior runtime; otherwise only the database and launcher
 * change. `serviceForVersion` builds the service that installs and restarts
 * on the point's prior version.
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
  const runtimeState = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath);
  if (!servesThisHome && Option.isSome(runtimeState) && isProcessAlive(runtimeState.value.pid)) {
    return yield* refuse(
      `A server is running on this T3 home at ${runtimeState.value.origin} (pid ${runtimeState.value.pid}) and no background service for this home can stop it. Stop it, then run t3 recover again.`,
    );
  }

  const record = (action: string, extra?: { readonly allowUnverifiedRuntime?: boolean }) =>
    Console.log(`  ${action}`).pipe(
      Effect.andThen(appendRecoveryAction(input.baseDir, id, action, extra)),
      Effect.mapError((error) => refuse(error.message)),
    );

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
    const afterStop = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath);
    if (Option.isSome(afterStop) && isProcessAlive(afterStop.value.pid)) {
      return yield* refuse(
        `Not recovering: the background service reported stopped but a server is still running on this T3 home (pid ${afterStop.value.pid}); the database was not moved. Stop that process, then run t3 recover again.`,
      );
    }
    yield* record("stopped the background service");
  }

  const stoppedNote = servesThisHome
    ? " The background service is stopped; run `t3 service restart` once the database is in place."
    : "";
  const displacedDir = yield* displaceDatabase(input.baseDir, input.dbPath, id).pipe(
    Effect.mapError((error) => refuse(`${error.message}${stoppedNote}`)),
  );
  yield* record(`moved the current database to ${displacedDir}`);
  yield* restoreSnapshot(input.baseDir, id, input.dbPath).pipe(
    Effect.mapError((error) =>
      refuse(`${error.message} The database it replaces is kept in ${displacedDir}.${stoppedNote}`),
    ),
  );
  yield* record(`restored the database from recovery point ${id}`);

  const runtime = pinnedRuntimePaths(path, input.baseDir, from.version, platform);
  const launchedAs = (yield* HostProcessIsExecutable) ? yield* resolveLauncherPath : undefined;
  const repointed = yield* repointLauncher({
    launchedAs,
    versionsDir: pinnedRuntimeVersionsDir(path, input.baseDir),
    targetEntryPath: runtime.entryPath,
  }).pipe(Effect.mapError((error) => refuse(error.message)));
  if (Option.isSome(repointed)) {
    yield* record(`pointed the launcher ${repointed.value} at t3@${from.version}`);
  } else {
    yield* Console.log(`  Run ${runtime.entryPath} to start t3@${from.version}.`);
  }

  if (servesThisHome) {
    const restarted = yield* BootService.BootService.pipe(
      Effect.flatMap((target) =>
        target.install({ allowDowngrade: true, start: false }).pipe(
          Effect.tap(() => record(`pointed the background service at t3@${from.version}`)),
          Effect.andThen(target.restart),
        ),
      ),
      Effect.provide(input.serviceForVersion(from.version)),
      Effect.mapError((error) =>
        error._tag === "CliRecoverError"
          ? error
          : refuse(
              `The database is restored but the background service could not be moved to t3@${from.version}: ${error.message}`,
            ),
      ),
    );
    if (!restarted) {
      return yield* refuse(
        `The database is restored but the background service was not restarted on t3@${from.version}. Run \`t3 service restart\`.`,
      );
    }
    yield* record(`restarted the background service on t3@${from.version}`);
  } else if (status.installed && status.installedBaseDir !== undefined) {
    yield* Console.log(
      `  The background service serves ${status.installedBaseDir} and was left unchanged.`,
    );
  }
  yield* Console.log(`Recovered to t3@${from.version}.`);
});
