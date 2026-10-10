import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

// This is process-start configuration from the operator's service environment,
// never a provider setting or an environment copied into a model process.
export const bridgeProfilePath = process.env.T3CODE_BRIDGE_PROFILE;
export const bridgeRequested = bridgeProfilePath !== undefined;

export { BridgeIsolationUnavailable } from "@t3tools/contracts";
import { BridgeIsolationUnavailable } from "@t3tools/contracts";

/** Native and SDK boundaries call this before resolving or invoking host code. */
export function assertUnconfinedExecutionAllowed(): void {
  if (bridgeRequested) throw new BridgeIsolationUnavailable({ reason: "unconfined-execution" });
}

/** Direct Effect spawns, including Git helpers, are denied in production composition. */
export const layerGuardedSpawner = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const raw = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) =>
      bridgeRequested
        ? Effect.fail(
            PlatformError.badArgument({
              module: "BridgeRuntime",
              method: "spawn",
              description: "Unconfined execution is disabled in the bridge service.",
              cause: new BridgeIsolationUnavailable({ reason: "unconfined-execution" }),
            }),
          )
        : raw.spawn(command),
    );
  }),
);

/** Follows local typed wrappers so existing failure envelopes retain the refusal. */
const isBridgeIsolationUnavailable = Schema.is(BridgeIsolationUnavailable);

export function bridgeFailure(cause: unknown): BridgeIsolationUnavailable | undefined {
  const seen = new Set<unknown>();
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    if (isBridgeIsolationUnavailable(cause)) return cause;
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return undefined;
}
