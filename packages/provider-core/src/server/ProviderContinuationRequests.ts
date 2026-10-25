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
  readonly delegatedCompletion?: {
    readonly parentRunId: RunId;
    readonly generation: number;
    readonly messageId: MessageId;
  };
  /** adapter_buffered (default) ingests existing CLI output; message_text delivers app-owned wake text. */
  readonly delivery?: "adapter_buffered" | "message_text";
  readonly messageId?: MessageId;
  readonly dispatchIfCurrent?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly clearIfCurrent?: () => Effect.Effect<void>;
}

/** The default drops requests; share the live layer with the worker that drains them. */
export class ProviderContinuationRequests extends Context.Reference<{
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
}>("@t3tools/provider-core/server/ProviderContinuationRequests", {
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
