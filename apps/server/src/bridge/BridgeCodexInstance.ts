import { type CodexSettings, ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import type {
  ProviderDriverCreateInput,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { createCodexAdapterV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makePendingCodexProvider } from "../provider/CodexProvider.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import { ProviderDriverError } from "../provider/Errors.ts";

/** Bridge instances never construct host auth, overlays, installers or probe subprocesses. */
export const makeBridgeCodexInstance = Effect.fn("makeBridgeCodexInstance")(function* (
  input: ProviderDriverCreateInput<CodexSettings>,
) {
  const driver = ProviderDriverKind.make("codex");
  const manifest = yield* ModelManifest.ModelManifest;
  const continuationIdentity = {
    driverKind: driver,
    continuationKey: `bridge:codex:${input.instanceId}`,
  };
  const stamp = withInstanceIdentity({
    ...input,
    accentColor: input.accentColor,
    driverKind: driver,
    continuationGroupKey: continuationIdentity.continuationKey,
  });
  const readSnapshot = Effect.zipWith(
    makePendingCodexProvider({ ...input.config, enabled: input.enabled }),
    manifest.current,
    (draft, models) =>
      stamp(
        ModelManifest.applyModelManifest(
          {
            ...draft,
            models: [
              ...(ModelManifest.resolveProviderCatalog(models, driver)?.models.map(
                (entry) => entry.model,
              ) ?? []),
              ...draft.models,
            ],
            version: "0.162.0",
            installed: true,
            status: input.enabled ? "ready" : "disabled",
            message:
              "Provision each thread offline from the stopped dedicated unit: t3 bridge-auth login --thread-id <thread-id> --workspace <absolute-workspace>. Host sign-in is unavailable.",
          },
          models,
          driver,
        ),
      ),
  );
  const snapshot = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed({ provider: driver, packageName: null, update: null }),
    getSettings: Effect.succeed(input.config),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => readSnapshot,
    checkProvider: readSnapshot,
    refreshOnInterval: false,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver,
          instanceId: input.instanceId,
          detail: "Failed to build the isolated Codex snapshot.",
          cause,
        }),
    ),
  );
  const orchestrationAdapter = yield* createCodexAdapterV2(input, {
    onUsageLimits: snapshot.applyUsageLimits,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver,
          instanceId: input.instanceId,
          detail: "Bridge Codex settings are unsupported.",
          cause,
        }),
    ),
  );
  const refuse = (operation: TextGenerationError["operation"]) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Background text generation is unavailable in the bridge service.",
      }),
    );
  return {
    ...input,
    driverKind: driver,
    continuationIdentity,
    snapshot,
    orchestrationAdapter,
    snapshotForCwd: () => snapshot.getSnapshot,
    textGeneration: {
      generateCommitMessage: () => refuse("generateCommitMessage"),
      generatePrContent: () => refuse("generatePrContent"),
      generateBranchName: () => refuse("generateBranchName"),
      generateThreadTitle: () => refuse("generateThreadTitle"),
    },
  } satisfies ProviderInstance;
});
