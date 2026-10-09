import {
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
  type ThreadId,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";

import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ADMITTED_ARCHIVE_MISMATCH_STEP, ensurePinnedRuntimeInstalled } from "./pinnedRuntime.ts";
import { createRecoveryPoint, RECOVERY_POINT_STEP } from "./recoveryPoint.ts";
import { verifyReleaseAdmission } from "./releaseAdmission.ts";
import { runStagedServicePreflight } from "./servicePreflight.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { isExactServiceVersion } from "./serviceProtocol.ts";

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  if (input.desktopManaged) return "desktop-managed" as const;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commitDesktopUpdate: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

export const withRunningThreadContinuation = Effect.fn(
  "cloud.server_self_update.withRunningThreadContinuation",
)(function* (input: {
  readonly mode: ServerConfig.RuntimeMode;
  readonly selfUpdate: ServerSelfUpdate["Service"];
  readonly prepare: Effect.Effect<ReadonlyArray<ThreadId>, ServerSelfUpdateError>;
  readonly clear: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<void, ServerSelfUpdateError>;
}) {
  const desktopContinuationTokens = yield* Ref.make(HashSet.empty<string>());
  const clearOnError = <A>(
    effect: Effect.Effect<A, ServerSelfUpdateError>,
    threadIds: () => ReadonlyArray<ThreadId>,
    handoffAccepted: () => boolean,
  ): Effect.Effect<A, ServerSelfUpdateError> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        (handoffAccepted() && Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : input.clear(threadIds())
        ).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );

  const update: ServerSelfUpdate["Service"]["update"] = (
    request,
    reportProgress = () => Effect.void,
  ) => {
    let prepared = false;
    let handoffAccepted = false;
    let continuationThreadIds: ReadonlyArray<ThreadId> = [];
    return clearOnError(
      input.selfUpdate
        .update(
          request,
          (stage) =>
            (request.continueRunningThreads === true &&
            input.mode !== "desktop" &&
            stage === "installing" &&
            !prepared
              ? input.prepare.pipe(
                  Effect.tap((threadIds) =>
                    Effect.sync(() => {
                      prepared = true;
                      continuationThreadIds = threadIds;
                    }),
                  ),
                  Effect.asVoid,
                )
              : Effect.void
            ).pipe(Effect.andThen(reportProgress(stage))),
          () =>
            Effect.sync(() => {
              handoffAccepted = true;
            }),
        )
        .pipe(
          Effect.tap((result) => {
            if (
              result.method === "desktop-app" &&
              result.desktopUpdateToken !== undefined &&
              request.continueRunningThreads === true
            ) {
              return Ref.update(desktopContinuationTokens, HashSet.add(result.desktopUpdateToken));
            }
            return Effect.void;
          }),
        ),
      () => continuationThreadIds,
      () => handoffAccepted,
    );
  };

  return ServerSelfUpdate.of({
    update,
    commitDesktopUpdate: (requestId) =>
      Effect.gen(function* () {
        const shouldContinue = yield* Ref.modify(desktopContinuationTokens, (tokens) => [
          HashSet.has(tokens, requestId),
          HashSet.remove(tokens, requestId),
        ]);
        let handoffAccepted = false;
        let continuationThreadIds: ReadonlyArray<ThreadId> = [];
        return yield* clearOnError(
          Effect.gen(function* () {
            continuationThreadIds = shouldContinue ? yield* input.prepare : [];
            return yield* input.selfUpdate.commitDesktopUpdate(requestId, () =>
              Effect.sync(() => {
                handoffAccepted = true;
              }),
            );
          }),
          () => continuationThreadIds,
          () => handoffAccepted,
        ).pipe(
          Effect.catchCause((cause) =>
            (shouldContinue && !handoffAccepted
              ? Ref.update(desktopContinuationTokens, HashSet.add(requestId))
              : Effect.void
            ).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      }),
  });
});

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const desktopAppUpdate = yield* DesktopAppUpdate.DesktopAppUpdate;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  // Archive-distributed targets download from GitHub Releases. The client is
  // optional so callers without one (tests, npm-only hosts) still construct.
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const inFlight = yield* Ref.make(false);

  const capability: ServerSelfUpdateCapability | null =
    serverConfig.mode === "desktop" ? "desktop-managed" : launcher.managed ? "boot-service" : null;
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (input, reportProgress = () => Effect.void, onHandoffAccepted = () => Effect.void) {
    if (capability === "desktop-managed") {
      // input.targetVersion is meaningless here: the desktop app's own
      // update feed decides what it downloads, and the result carries what
      // it actually got.
      if (desktopAppUpdate.available) {
        return yield* desktopAppUpdate.run(reportProgress);
      }
      return yield* failWith(
        "This server is managed by the T3 Code desktop app on its machine; update the desktop app to update it.",
      );
    }
    if (capability === null) {
      return yield* failWith(
        "Remote updates require the T3 Code background service. Run `t3 service install` on the server machine.",
      );
    }

    const targetVersion = input.targetVersion.trim();
    if (!isExactServiceVersion(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
    }
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }

    return yield* Effect.gen(function* () {
      // A recovery point of the database and the version the service runs
      // now, kept inside validation after the preflight so a failed backup
      // means the new runtime is never published. Cached so a second
      // validation in this update reuses the point instead of taking another.
      // This process is the service's running server, so its own version is
      // the one running; service-state.json can already name a version that
      // `t3 update` installed with its restart deferred.
      const keepRecoveryPoint = yield* Effect.cached(
        createRecoveryPoint({
          baseDir: serverConfig.baseDir,
          dbPath: serverConfig.dbPath,
          fromVersion: packageJson.version,
          toVersion: targetVersion,
        }).pipe(
          Effect.tap((point) =>
            Option.isSome(point)
              ? Effect.logInfo("Kept a recovery point before the server update.", {
                  recoveryPointId: point.value.id,
                  recoveryPointPath: point.value.dir,
                })
              : Effect.void,
          ),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      );
      yield* reportProgress("downloading");
      // A fork version installs only with an admission record for its exact
      // archive. Unlike `t3 update`, there is no override here.
      const admittedArchiveSha256 = yield* verifyReleaseAdmission({
        httpClient,
        version: targetVersion,
        platform,
        arch,
        releaseBaseUrl,
      }).pipe(Effect.mapError((error) => failWith(error.reason, error)));
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir: serverConfig.baseDir,
        version: targetVersion,
        fs,
        path,
        runner,
        httpClient,
        platform,
        arch,
        releaseBaseUrl,
        admittedArchiveSha256,
        validate: (runtime) =>
          runStagedServicePreflight({
            runner,
            runtime,
            databasePath: serverConfig.dbPath,
            targetVersion,
          }).pipe(Effect.andThen(keepRecoveryPoint), Effect.asVoid),
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PinnedRuntimePreflightBlockedError"
            ? failWith(error.reason, error)
            : error.step === RECOVERY_POINT_STEP
              ? failWith(
                  `Not switching to t3@${targetVersion}: could not keep a recovery point of the database.`,
                  error,
                )
              : error.step === ADMITTED_ARCHIVE_MISMATCH_STEP
                ? failWith(
                    `The archive downloaded for t3@${targetVersion} is not the one its admission record admitted.`,
                    error,
                  )
                : failWith(`Could not prepare t3@${targetVersion}.`, error),
        ),
      );

      yield* reportProgress("installing");
      const updateId = yield* Effect.uninterruptible(
        launcher.requestUpdate({ targetVersion, dbPath: serverConfig.dbPath }).pipe(
          Effect.mapError((error) =>
            failWith(
              error._tag === "ServiceLauncherRejectedError"
                ? error.reason
                : "Could not ask the service launcher to activate the prepared update.",
              error,
            ),
          ),
          Effect.tap(() => onHandoffAccepted()),
        ),
      );

      yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
        updateId,
        targetVersion,
        runtimePath: paths.entryPath,
      });
      return { targetVersion, method: "boot-service" as const, updateId };
    }).pipe(Effect.onError(() => Ref.set(inFlight, false)));
  });

  return ServerSelfUpdate.of({
    update,
    commitDesktopUpdate: (requestId, onHandoffAccepted) =>
      desktopAppUpdate.commit(requestId, onHandoffAccepted),
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
