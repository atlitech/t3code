// @effect-diagnostics nodeBuiltinImport:off -- The owned native supervisor needs Node process handles, not numeric process groups.
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSink from "@effect/platform-node/NodeSink";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const processError = (cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "BridgeNamespaceProcess",
    method: "supervise",
    cause,
  });

/** Scope close requests supervisor teardown and awaits all adopted descendants. */
export const spawnNamespaceProcess = (
  supervisor: string,
  command: ChildProcess.StandardCommand,
  onLostOwnership: () => void = () => {},
) =>
  Effect.gen(function* () {
    const owned = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<{
            child: NodeChildProcess.ChildProcessWithoutNullStreams;
            closed: Promise<number>;
          }>((resolve, reject) => {
            const child = NodeChildProcess.spawn(supervisor, [command.command, ...command.args], {
              stdio: ["pipe", "pipe", "pipe", "pipe"],
              env: {},
              shell: false,
              detached: false,
            });
            child.stdin.on("error", () => {});
            let ready = false;
            const closed = new Promise<number>((done) =>
              child.once("exit", (code, signal) => {
                if (!ready) reject(new Error("Supervisor stopped before ready."));
                if (signal !== null || code === 126) {
                  onLostOwnership();
                  done(126);
                } else done(code ?? 125);
              }),
            );
            child.once("error", reject);
            const receipt = child.stdio[3];
            if (receipt && "once" in receipt) {
              receipt.once("data", (chunk: Buffer) => {
                if (chunk.toString() === "R") {
                  ready = true;
                  resolve({
                    child: child as NodeChildProcess.ChildProcessWithoutNullStreams,
                    closed,
                  });
                } else reject(new Error("Invalid supervisor startup receipt."));
              });
              receipt.once("end", () => {
                if (child.exitCode !== null) reject(new Error("Supervisor stopped before ready."));
              });
            }
          }),
        catch: processError,
      }),
      ({ child, closed }) =>
        Effect.tryPromise({
          try: async () => {
            // ChildProcess.kill uses its owned native handle and is a no-op after
            // exit. SIGTERM asks the supervisor to kill via pidfd and drain waitpid.
            child.kill("SIGTERM");
            if ((await closed) === 126) throw new Error("Namespace teardown ownership was lost.");
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
          },
          catch: processError,
        }).pipe(Effect.orDie),
    );
    const { child, closed } = owned;
    const stdout = NodeStream.fromReadable<Uint8Array, PlatformError.PlatformError>({
      evaluate: () => child.stdout,
      onError: processError,
      closeOnDone: false,
    });
    const stderr = NodeStream.fromReadable<Uint8Array, PlatformError.PlatformError>({
      evaluate: () => child.stderr,
      onError: processError,
      closeOnDone: false,
    });
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(child.pid!),
      exitCode: Effect.tryPromise({
        try: () =>
          closed.then((code) => {
            if (code === 126) throw new Error("Namespace teardown ownership was lost.");
            return ChildProcessSpawner.ExitCode(code);
          }),
        catch: processError,
      }),
      isRunning: Effect.sync(() => child.exitCode === null && child.signalCode === null),
      kill: () =>
        Effect.tryPromise({
          try: async () => {
            child.kill("SIGTERM");
            if ((await closed) === 126) throw new Error("Namespace teardown ownership was lost.");
          },
          catch: processError,
        }),
      stdin: NodeSink.fromWritable({
        evaluate: () => child.stdin,
        onError: processError,
        endOnDone: false,
      }),
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.sync(() => {
        child.unref();
        return Effect.sync(() => child.ref());
      }),
    });
  });
