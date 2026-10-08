import {
  type OrchestrationV2Notification,
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

export interface ProviderContinuationRequest {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly detail: string | null;
  readonly notification?: OrchestrationV2Notification;
  /**
   * Durable ownership for an app-owned delegated-task completion delivery.
   * The continuation worker re-reads the cohort before dispatching so a later
   * task can join a queued wake and a stopped or acknowledged cohort is dropped.
   */
  readonly delegatedCompletion?: {
    readonly parentRunId: RunId;
    readonly generation: number;
    readonly messageId: MessageId;
  };
  /**
   * How the continuation turn gets its content.
   *
   * `adapter_buffered` (default) is the provider-native wake: the adapter has
   * already buffered the CLI's wake output, and the dispatched message only
   * triggers ingestion. `ClaudeAdapterV2` deliberately discards the message
   * text on that path.
   *
   * `message_text` is for app-owned work with no buffered provider output, such
   * as a delegated child finishing. The text is the entire wake, so it must
   * reach the provider as a real prompt.
   */
  readonly delivery?: "adapter_buffered" | "message_text";
  readonly dispatchIfCurrent?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  /** Clears a pending offer that the continuation worker intentionally drops. */
  readonly clearIfCurrent?: () => Effect.Effect<void>;
}

/**
 * Adapters offer a continuation request when provider-native work completes
 * outside an active turn (for example a Claude background task wake turn) so
 * the orchestrator can start a run that ingests it. The default reference
 * drops requests, keeping adapter construction dependency-free in tests; the
 * live layer must be shared with the ProviderContinuationService worker that
 * drains it.
 */
export class ProviderContinuationRequests extends Context.Reference<{
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
}>("t3/orchestration-v2/ProviderContinuationRequests", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

/** Message-scoped native wake cleanup, settled by post-commit effects. */
export class ProviderContinuationCleanup extends Context.Reference<{
  readonly register: (messageId: MessageId, clear: Effect.Effect<void>) => Effect.Effect<void>;
  readonly discard: (messageId: MessageId) => Effect.Effect<void>;
  readonly release: (messageId: MessageId) => Effect.Effect<void>;
}>("t3/orchestration-v2/ProviderContinuationCleanup", {
  defaultValue: () => ({
    register: () => Effect.void,
    discard: () => Effect.void,
    release: () => Effect.void,
  }),
}) {}

const layerCleanup = Layer.effect(
  ProviderContinuationCleanup,
  Effect.gen(function* () {
    const callbacks = yield* Ref.make(new Map<MessageId, Effect.Effect<void>>());
    const take = (messageId: MessageId) =>
      Ref.modify(callbacks, (current) => {
        const clear = current.get(messageId);
        if (clear === undefined) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(messageId);
        return [clear, next] as const;
      });
    return {
      register: (messageId: MessageId, clear: Effect.Effect<void>) =>
        Ref.update(callbacks, (current) => new Map(current).set(messageId, clear)),
      discard: (messageId: MessageId) =>
        take(messageId).pipe(Effect.flatMap((clear) => clear ?? Effect.void)),
      release: (messageId: MessageId) => take(messageId).pipe(Effect.asVoid),
    };
  }),
);

const layerRequests = Layer.effect(
  ProviderContinuationRequests,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderContinuationRequest>();
    return {
      offer: (request: ProviderContinuationRequest) =>
        Queue.offer(queue, request).pipe(Effect.asVoid),
      take: Queue.take(queue),
    };
  }),
);

export const layer = Layer.merge(layerRequests, layerCleanup);
