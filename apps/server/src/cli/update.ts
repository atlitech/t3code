import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_CHANNELS,
  cliReleaseIndexPageUrl,
  cliReleaseChannelOf,
  newestCliReleaseVersion,
  type CliReleaseChannel,
} from "@t3tools/shared/cliRelease";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import {
  ADMITTED_ARCHIVE_MISMATCH_STEP,
  ensurePinnedRuntimeInstalled,
  isPinnedRuntimeInstalled,
  pinnedRuntimeVersionsDir,
  launcherOwnsVersionsDir,
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  prunePinnedRuntimes,
  windowsShimTarget,
} from "../cloud/pinnedRuntime.ts";
import {
  createRecoveryPoint,
  RECOVERY_POINT_STEP,
  type RecoveryPoint,
} from "../cloud/recoveryPoint.ts";
import { PRE_ADMISSION_FORK_VERSIONS, verifyReleaseAdmission } from "../cloud/releaseAdmission.ts";
import {
  runStagedServicePreflight,
  SERVICE_PREFLIGHT_UNSUPPORTED_STEP,
} from "../cloud/servicePreflight.ts";
import { compareExactServiceVersions, isExactServiceVersion } from "../cloud/serviceProtocol.ts";
import * as ProcessRunner from "../processRunner.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { createUpdateProgress } from "./updateProgress.ts";
import * as CliService from "./service.ts";

export class CliUpdateError extends Schema.TaggedError<CliUpdateError>()("CliUpdateError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
  }),
);
const decodeReleaseIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));

const RELEASE_INDEX_TIMEOUT = Duration.seconds(30);
const RELEASE_INDEX_MAX_PAGES = 10;

export const resolveNewestVersion = Effect.fn("cli.update.resolve_newest")(function* (
  channel: CliReleaseChannel,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const githubToken = environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim() || undefined;
  for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
    const request = HttpClientRequest.get(cliReleaseIndexPageUrl(page)).pipe(
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
    );
    const authenticatedRequest =
      githubToken === undefined
        ? request
        : HttpClientRequest.setHeader(request, "Authorization", `Bearer ${githubToken}`);
    const body = yield* httpClient.execute(authenticatedRequest).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.mapError(() => new CliUpdateError({ reason: "Could not list t3 releases." })),
      Effect.timeoutOrElse({
        duration: RELEASE_INDEX_TIMEOUT,
        orElse: () => Effect.fail(new CliUpdateError({ reason: "Timed out listing t3 releases." })),
      }),
    );
    const releases = yield* decodeReleaseIndex(body).pipe(
      Effect.mapError(
        () => new CliUpdateError({ reason: "The t3 release index had an unexpected shape." }),
      ),
    );
    const version = newestCliReleaseVersion(releases, channel);
    if (version !== undefined) return version;
    if (releases.length === 0) break;
  }
  return yield* new CliUpdateError({ reason: `No published ${channel} release was found.` });
});

/**
 * Only a launcher that already points into this home's `runtime/versions` tree is touched; a
 * plain copy of the executable, or a launcher for some other install, is left alone.
 */
export const repointLauncher = Effect.fn("cli.update.repoint_launcher")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly versionsDir: string;
  readonly targetEntryPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  if (input.launchedAs === undefined) return Option.none<string>();
  const ownsTarget = (candidate: string) =>
    launcherOwnsVersionsDir(path, input.versionsDir, candidate);

  if (platform === "win32") {
    const shimPath = yield* findWindowsShim(input.launchedAs);
    if (shimPath === undefined) return Option.none<string>();
    const current = yield* fs.readFileString(shimPath).pipe(Effect.option);
    const quoted = Option.isSome(current) ? windowsShimTarget(current.value) : undefined;
    if (quoted === undefined || !ownsTarget(quoted)) return Option.none<string>();
    yield* fs
      .writeFileString(shimPath, `@echo off\r\n"${input.targetEntryPath}" %*`)
      .pipe(
        Effect.mapError(
          () => new CliUpdateError({ reason: `Could not rewrite the t3 launcher at ${shimPath}.` }),
        ),
      );
    return Option.some(shimPath);
  }

  const linkTarget = yield* fs.readLink(input.launchedAs).pipe(Effect.option);
  if (Option.isNone(linkTarget)) return Option.none<string>();
  const resolvedTarget = path.resolve(path.dirname(input.launchedAs), linkTarget.value);
  if (!ownsTarget(resolvedTarget)) return Option.none<string>();
  const tempLink = `${input.launchedAs}.${process.pid}.tmp`;
  yield* fs.symlink(input.targetEntryPath, tempLink).pipe(
    Effect.andThen(fs.rename(tempLink, input.launchedAs)),
    Effect.mapError(
      () =>
        new CliUpdateError({ reason: `Could not repoint the t3 launcher at ${input.launchedAs}.` }),
    ),
  );
  return Option.some(input.launchedAs);
});

/** Node preserves argv0's spelling; resolve bare names on PATH to find the launcher symlink. */
export const resolveLauncherPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const invokedAs = yield* HostProcess.InvokedAs;
  const cwd = yield* HostProcess.WorkingDirectory;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  if (invokedAs.includes("/") || invokedAs.includes("\\")) {
    return path.resolve(cwd, invokedAs);
  }
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of (environment["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, invokedAs);
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }
  return undefined;
});

/** Windows executables see their own path, so find the installer shim by matching t3.cmd targets on PATH. */
export const findWindowsShim = Effect.fn("cli.update.find_windows_shim")(function* (
  executablePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const candidates = [
    ...(environment["T3CODE_INSTALL_BIN_DIR"] ? [environment["T3CODE_INSTALL_BIN_DIR"]] : []),
    ...(environment["PATH"] ?? environment["Path"] ?? "").split(";"),
  ].filter((entry) => entry.trim().length > 0);
  for (const directory of candidates) {
    const shimPath = path.join(directory, "t3.cmd");
    const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
    if (Option.isNone(contents)) continue;
    const target = windowsShimTarget(contents.value);
    if (
      target !== undefined &&
      path.resolve(target).toLowerCase() === path.resolve(executablePath).toLowerCase()
    ) {
      return shimPath;
    }
  }
  return undefined;
});

const updateFlags = {
  ...projectLocationFlags,
  channel: Flag.Literals("channel", CLI_RELEASE_CHANNELS).pipe(
    Flag.withDescription(
      "Release channel to follow. Defaults to the channel this t3 was published on.",
    ),
    Flag.optional,
  ),
  allowDowngrade: Flag.Boolean("allow-downgrade").pipe(
    Flag.withDescription("Allow moving to an older version than the one running."),
    Flag.withDefault(false),
  ),
  allowUnadmitted: Flag.Boolean("allow-unadmitted").pipe(
    Flag.withDescription(
      `Install a fork version that predates admission records (${PRE_ADMISSION_FORK_VERSIONS.join(", ")}) without one.`,
    ),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Restart the background service without asking. Required to restart it from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
};

const versionArgument = Argument.String("version").pipe(
  Argument.withDescription(
    "Exact version to install. Defaults to the newest release on the channel.",
  ),
  Argument.optional,
);

export const updateCommand = Command.make("update", {
  ...updateFlags,
  version: versionArgument,
}).pipe(
  Command.withDescription(
    "Download a newer t3 and switch this machine to it, including the background service when one is installed.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUpdate({
        baseDir: config.baseDir,
        logsDir: config.logsDir,
        serverRuntimeStatePath: config.serverRuntimeStatePath,
        dbPath: config.dbPath,
        channel: Option.getOrUndefined(flags.channel),
        requestedVersion: Option.getOrUndefined(flags.version),
        allowDowngrade: flags.allowDowngrade,
        allowUnadmitted: flags.allowUnadmitted,
        assumeYes: flags.yes,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(CliService.layer(config), ProcessRunner.layer, FetchHttpClient.layer),
        ),
      );
    }),
  ),
);

/**
 * Refuses a fork target whose release does not admit this machine's archive,
 * and resolves the admitted archive digest (undefined for official versions).
 * The owner can override only for the fork versions that predate admission
 * records, and the override is logged.
 */
const admitUpdateTarget = Effect.fn("cli.update.admit_target")(function* (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly releaseBaseUrl: string | undefined;
  readonly allowUnadmitted: boolean;
}) {
  return yield* verifyReleaseAdmission(input).pipe(
    Effect.catchTags({
      ReleaseAdmissionError: (error) => {
        const preAdmission = PRE_ADMISSION_FORK_VERSIONS.includes(error.version);
        if (input.allowUnadmitted && preAdmission) {
          return Console.log(
            `  Installing t3@${error.version} without admission (--allow-unadmitted): ${error.reason}`,
          ).pipe(
            Effect.andThen(
              Effect.logWarning(
                "t3 update is installing an unadmitted pre-admission version.",
              ).pipe(Effect.annotateLogs({ version: error.version, reason: error.reason })),
            ),
            Effect.as(undefined),
          );
        }
        return Effect.fail(
          new CliUpdateError({
            reason: preAdmission
              ? `${error.reason} Pass --allow-unadmitted to install this pre-admission version anyway.`
              : input.allowUnadmitted
                ? `${error.reason} --allow-unadmitted applies only to ${PRE_ADMISSION_FORK_VERSIONS.join(", ")}.`
                : error.reason,
          }),
        );
      },
    }),
  );
});

export const findForegroundServer = Effect.fn("cli.update.find_foreground_server")(
  function* (input: {
    readonly serverRuntimeStatePath: string;
    readonly serviceInstalled: boolean;
  }) {
    const state = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath);
    if (Option.isNone(state) || state.value.serviceManaged || !isProcessAlive(state.value.pid)) {
      return undefined;
    }
    if (input.serviceInstalled && (yield* belongsToBootService(state.value.pid))) return undefined;
    return state.value;
  },
);

const belongsToBootService = Effect.fn("cli.update.belongs_to_boot_service")(function* (
  pid: number,
) {
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  if (platform === "linux") {
    const cgroup = yield* fs.readFileString(`/proc/${pid}/cgroup`).pipe(Effect.option);
    return Option.isSome(cgroup) && cgroup.value.includes("/t3code.service");
  }
  if (platform === "darwin") {
    const parent = yield* runner
      .run({
        command: "ps",
        args: ["-o", "ppid=", "-p", String(pid)],
        timeout: Duration.seconds(5),
      })
      .pipe(Effect.option);
    const ppid = Option.isSome(parent) && parent.value.code === 0 ? parent.value.stdout.trim() : "";
    if (!/^\d+$/.test(ppid)) return false;
    const command = yield* runner
      .run({ command: "ps", args: ["-o", "command=", "-p", ppid], timeout: Duration.seconds(5) })
      .pipe(
        Effect.map((result) => (result.code === 0 ? result.stdout : "")),
        Effect.orElseSucceed(() => ""),
      );
    return /__service-launcher/.test(command);
  }
  return false;
});

/**
 * The version the live service-managed server on this home runs, read from
 * its command line: the launcher starts `<versions>/<version>/t3 serve`.
 * Undefined when no such server is alive or its command line does not say.
 */
const runningServiceServerVersion = Effect.fn("cli.update.running_service_server_version")(
  function* (input: { readonly serverRuntimeStatePath: string; readonly versionsDir: string }) {
    const platform = yield* HostProcess.Platform;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const state = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath);
    if (Option.isNone(state) || !state.value.serviceManaged || !isProcessAlive(state.value.pid)) {
      return undefined;
    }
    const pid = String(state.value.pid);
    const commandLine =
      platform === "linux"
        ? yield* fs.readFileString(`/proc/${pid}/cmdline`).pipe(Effect.orElseSucceed(() => ""))
        : platform === "darwin"
          ? yield* runner
              .run({
                command: "ps",
                args: ["-o", "command=", "-p", pid],
                timeout: Duration.seconds(5),
              })
              .pipe(
                Effect.map((result) => (result.code === 0 ? result.stdout : "")),
                Effect.orElseSucceed(() => ""),
              )
          : "";
    const prefix = `${input.versionsDir}${path.sep}`;
    const start = commandLine.indexOf(prefix);
    if (start < 0) return undefined;
    const version = commandLine.slice(start + prefix.length).split(path.sep)[0];
    return version !== undefined && isExactServiceVersion(version) ? version : undefined;
  },
);

export const runUpdate = Effect.fn("cli.update.run")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly serverRuntimeStatePath: string;
  readonly dbPath: string;
  readonly channel: CliReleaseChannel | undefined;
  readonly requestedVersion: string | undefined;
  readonly allowDowngrade: boolean;
  readonly allowUnadmitted: boolean;
  readonly assumeYes: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const httpClient = yield* HttpClient.HttpClient;
  const service = yield* BootService.BootService;

  const currentVersion = packageJson.version;
  const channel = input.channel ?? cliReleaseChannelOf(currentVersion);
  if (input.requestedVersion !== undefined && !isExactServiceVersion(input.requestedVersion)) {
    return yield* new CliUpdateError({
      reason: `'${input.requestedVersion}' is not an exact t3 version.`,
    });
  }
  const progress = createUpdateProgress();
  progress.status("Checking for updates...");
  const targetVersion = yield* (
    input.requestedVersion === undefined
      ? resolveNewestVersion(channel)
      : Effect.succeed(input.requestedVersion)
  ).pipe(Effect.ensuring(Effect.sync(progress.finish)));
  const targetChannel = cliReleaseChannelOf(targetVersion);

  const currentChannel = cliReleaseChannelOf(currentVersion);
  if (targetChannel === "preview" && currentChannel !== "preview") {
    yield* Console.log(
      [
        `t3@${targetVersion} is a preview build.`,
        "  Preview builds are cut by maintainers from unreleased branches to exercise the release",
        "  pipeline. They can be broken, receive no fixes, and are never offered as updates; you",
        `  will have to switch back to ${currentChannel} yourself with \`t3 update --channel ${currentChannel} --allow-downgrade\`.`,
      ].join("\n"),
    );
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUpdateError({
        reason:
          "Refusing to install a preview build without confirmation. Run this from a terminal to confirm, or pass --channel preview from an interactive shell.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({ message: "Install the preview build anyway?", initial: false }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  const status = yield* service.status;
  // Service names are per user, so another home's unit belongs to a different install.
  const servesThisHome =
    status.installedBaseDir !== undefined &&
    path.resolve(status.installedBaseDir) === path.resolve(input.baseDir);
  const serviceInstalled = status.supported && status.installed && servesThisHome;
  const foreground = yield* findForegroundServer({
    serverRuntimeStatePath: input.serverRuntimeStatePath,
    serviceInstalled,
  });
  const serviceVersion = serviceInstalled ? status.installedVersion : undefined;
  const executableCurrent = targetVersion === currentVersion;
  const restartPending = status.problems?.includes("restart-pending") === true;
  const serviceCurrent =
    !serviceInstalled ||
    (serviceVersion === targetVersion &&
      (executableCurrent ? status.current : (status.problems ?? []).length === 0));
  const newestInstalled =
    serviceVersion !== undefined && compareExactServiceVersions(serviceVersion, currentVersion) > 0
      ? serviceVersion
      : currentVersion;

  if (executableCurrent && serviceCurrent) {
    yield* Console.log(
      serviceVersion !== undefined
        ? `t3 and its background service are already on ${targetVersion} (${targetChannel}).`
        : `t3 is already on ${targetVersion} (${targetChannel}).`,
    );
    return;
  }
  if (!input.allowDowngrade && compareExactServiceVersions(targetVersion, newestInstalled) < 0) {
    return yield* new CliUpdateError({
      reason: `t3@${targetVersion} is older than the installed ${newestInstalled}. Pass --allow-downgrade to install it anyway.`,
    });
  }
  const releaseBaseUrl = environment[CLI_RELEASE_BASE_URL_ENV]?.trim() || undefined;
  const admittedArchiveSha256 = yield* admitUpdateTarget({
    httpClient,
    version: targetVersion,
    platform,
    arch,
    releaseBaseUrl,
    allowUnadmitted: input.allowUnadmitted,
  });
  // Releases before the update preflight existed do not know the command; a
  // rollback to one still has to work, so on a downgrade, and only when the
  // target plainly does not know the command, is its failure tolerated. A
  // preflight that runs and fails or answers blocked refuses either way.
  const isDowngrade = compareExactServiceVersions(targetVersion, currentVersion) < 0;

  // A cached runtime counts only when it is the admitted archive; otherwise
  // the install below replaces it, so this is an update, not a switch.
  const alreadyOnDisk = yield* isPinnedRuntimeInstalled({
    fs,
    path,
    baseDir: input.baseDir,
    version: targetVersion,
    platform,
    admittedArchiveSha256,
  });

  progress.heading(
    executableCurrent && restartPending
      ? `The background service is still running the version before ${targetVersion} (${targetChannel}).`
      : executableCurrent
        ? `Updating the background service ${serviceVersion ?? "(unknown version)"} -> ${targetVersion} (${targetChannel}).`
        : alreadyOnDisk
          ? "Switching T3 Code"
          : "Updating T3 Code",
    executableCurrent
      ? ""
      : `${currentVersion} → ${targetVersion}${targetChannel === "stable" ? "" : ` (${targetChannel})`}`,
  );
  let restartService = false;
  if (serviceInstalled && !serviceCurrent) {
    yield* Console.log(
      "  A background service is installed for this T3 home. Restarting it interrupts anything running in it: agent turns, terminals, remote clients.",
    );
    if (input.assumeYes) {
      restartService = true;
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      restartService = yield* Prompt.run(
        Prompt.Confirm({
          message: "Restart the background service once the download is verified?",
          initial: true,
        }),
      ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    } else {
      yield* Console.log(
        "  Not a terminal, so the service keeps running its current version. Rerun with --yes to restart it now, or run `t3 service restart` later.",
      );
    }
  }

  // A recovery point of the database and the version this home runs now, so
  // `t3 recover` can return to both. It is kept inside validation, after the
  // preflight, so a failed backup means the new runtime is never published;
  // cached so a second validation in this run (a concurrent publish) reuses
  // the point rather than taking another and evicting an older good one.
  // The service's recorded version is what it runs unless a restart is
  // pending: an earlier update declined the restart, so service-state.json
  // already names the newer version while the old server keeps the database.
  // Then the live server's own command line is the truthful source, and the
  // running t3 the fallback when that cannot be read.
  const fromVersion =
    serviceInstalled && restartPending
      ? ((yield* runningServiceServerVersion({
          serverRuntimeStatePath: input.serverRuntimeStatePath,
          versionsDir: pinnedRuntimeVersionsDir(path, input.baseDir),
        })) ?? currentVersion)
      : (serviceVersion ?? currentVersion);
  let keptPoint: RecoveryPoint | undefined;
  const keepRecoveryPoint = yield* Effect.cached(
    createRecoveryPoint({
      baseDir: input.baseDir,
      dbPath: input.dbPath,
      fromVersion,
      toVersion: targetVersion,
    }).pipe(
      Effect.tap((point) =>
        Effect.sync(() => {
          keptPoint = Option.getOrUndefined(point);
        }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    ),
  );

  const runtime = yield* ensurePinnedRuntimeInstalled({
    onProgress: progress.report,
    baseDir: input.baseDir,
    version: targetVersion,
    fs,
    path,
    runner,
    httpClient,
    platform,
    arch,
    releaseBaseUrl,
    admittedArchiveSha256,
    validate: (paths) =>
      runner
        .run({
          command: pinnedRuntimeCommand(paths).command,
          args: [...pinnedRuntimeCommand(paths).args, "--version"],
          timeout: Duration.seconds(30),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PinnedRuntimeInstallError({ step: "verifying the downloaded t3", cause }),
          ),
          Effect.flatMap((result) =>
            result.code === 0 && /\bv(\S+)\s*$/.exec(result.stdout)?.[1] === targetVersion
              ? Effect.void
              : Effect.fail(
                  new PinnedRuntimeInstallError({
                    step: "verifying the downloaded t3",
                    exitCode: Number(result.code),
                  }),
                ),
          ),
          // Migrates a copy of this home's database with the new runtime, so a
          // version that cannot read the data is refused before anything moves.
          Effect.andThen(
            runStagedServicePreflight({
              runner,
              runtime: paths,
              databasePath: input.dbPath,
              targetVersion,
            }).pipe(
              Effect.catchIf(
                (error) =>
                  isDowngrade &&
                  error._tag === "PinnedRuntimeInstallError" &&
                  error.step === SERVICE_PREFLIGHT_UNSUPPORTED_STEP,
                () =>
                  Effect.logWarning(
                    "The downgrade target has no update preflight; its database check was skipped.",
                  ).pipe(Effect.annotateLogs({ targetVersion })),
              ),
            ),
          ),
          Effect.andThen(keepRecoveryPoint),
          Effect.asVoid,
        ),
  }).pipe(
    Effect.ensuring(Effect.sync(progress.finish)),
    Effect.mapError((error) => {
      if (error._tag === "PinnedRuntimePreflightBlockedError") {
        return new CliUpdateError({
          reason: `Not switching to t3@${targetVersion}: ${error.reason}`,
        });
      }
      if (error.step === RECOVERY_POINT_STEP) {
        return new CliUpdateError({
          reason: `Not switching to t3@${targetVersion}: could not keep a recovery point of the database at ${input.dbPath}. Nothing was changed.`,
        });
      }
      if (error.step === ADMITTED_ARCHIVE_MISMATCH_STEP) {
        return new CliUpdateError({
          reason: `The archive downloaded for t3@${targetVersion} is not the one its admission record admitted.`,
        });
      }
      if (
        error.step.startsWith("downloading the t3 release checksums") &&
        String(error.cause).includes("404")
      ) {
        return new CliUpdateError({
          reason: `No release archive was published for t3@${targetVersion}.`,
        });
      }
      return error;
    }),
  );

  if (keptPoint !== undefined) {
    yield* Console.log(
      `  Kept recovery point ${keptPoint.id} (${keptPoint.dir}); \`t3 recover ${keptPoint.id}\` restores t3@${keptPoint.record.from.version} and the database as it is now.`,
    );
  }

  const launchedAs = (yield* HostProcess.IsExecutable) ? yield* resolveLauncherPath : undefined;
  const repointed = yield* repointLauncher({
    launchedAs,
    versionsDir: path.dirname(runtime.versionDir),
    targetEntryPath: runtime.entryPath,
  });

  // Use today's service manager for the target version. Inside the service it hands off to
  // the target CLI, so stopping this process cannot interrupt the switch.
  let servicePlan: BootService.BootServicePlan | undefined;
  if (serviceInstalled && !serviceCurrent) {
    yield* Console.log(
      restartService
        ? "Restarting the background service..."
        : "Updating the background service...",
    );
    servicePlan = yield* BootService.BootService.pipe(
      Effect.flatMap((target) =>
        target.install({ allowDowngrade: input.allowDowngrade, start: restartService }),
      ),
      Effect.provide(
        BootService.layer({
          baseDir: input.baseDir,
          logsDir: input.logsDir,
          cliVersion: targetVersion,
        }),
      ),
      Effect.mapError(
        (error) =>
          new CliUpdateError({
            reason: `t3@${targetVersion} is installed but the background service could not be ${restartService ? "updated" : "pointed at it"}: ${error.message}`,
          }),
      ),
    );
  }

  // A handed-off service install rewrites the unit later, while the old launcher may be stopped.
  if (servicePlan?.handedOff !== true) {
    // A stopped service's unit still names the launcher runtime it will start.
    const unit = yield* fs.readFileString(status.unitPath).pipe(Effect.option);
    yield* prunePinnedRuntimes({
      baseDir: input.baseDir,
      keep: [currentVersion, targetVersion],
      references: Option.toArray(Option.flatMapNullishOr(unit, BootService.bootServiceProgramOf)),
    });
  }

  progress.success(`Installed T3 Code ${targetVersion}`);
  if (Option.isSome(repointed)) {
    yield* Console.log("  Run t3 to get started.\n");
  } else {
    yield* Console.log(`  Run ${runtime.entryPath}\n`);
  }
  if (servicePlan?.handedOff === true) {
    yield* Console.log(
      `  Background service switching to ${targetVersion} from a separate systemd unit, since this session runs inside it and disconnects when it restarts. Result: ${servicePlan.logPath}`,
    );
  } else if (servicePlan !== undefined && restartService) {
    yield* Console.log(`  Background service restarted on ${targetVersion}`);
  } else if (serviceInstalled && serviceCurrent) {
    yield* Console.log(`  Background service already on ${targetVersion}`);
  } else if (serviceInstalled) {
    yield* Console.log(
      `  Background service still running ${serviceVersion ?? "an unknown version"}. Run \`t3 service restart\` when you are ready to switch it to ${targetVersion}.`,
    );
  } else if (status.installed && !servesThisHome) {
    yield* Console.log(
      `  The background service serves ${status.installedBaseDir ?? "another T3 home"} and was left unchanged.`,
    );
  }
  if (foreground !== undefined) {
    yield* Console.log(
      `  A server started by hand is still running at ${foreground.origin} (pid ${foreground.pid}). Stop it and start it again to pick up ${targetVersion}.`,
    );
  }
});
