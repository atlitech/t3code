import type { IdAllocatorV2Shape } from "@t3tools/provider-core/server/IdAllocator";

/** Native IDs are untrusted and only identify objects within an admitted app thread. */
export function isolateProviderIdentity(
  base: IdAllocatorV2Shape,
  threadId: string,
): IdAllocatorV2Shape {
  const native = (id: string) => `${encodeURIComponent(threadId)}:${encodeURIComponent(id)}`;
  return {
    allocate: base.allocate,
    derive: {
      ...base.derive,
      providerThread: (input) =>
        base.derive.providerThread({ ...input, nativeThreadId: native(input.nativeThreadId) }),
      threadFromProviderThread: (input) =>
        base.derive.threadFromProviderThread({
          ...input,
          nativeThreadId: native(input.nativeThreadId),
        }),
      providerTurn: (input) =>
        base.derive.providerTurn({ ...input, nativeTurnId: native(input.nativeTurnId) }),
      nodeFromProviderItem: (input) =>
        base.derive.nodeFromProviderItem({ ...input, nativeItemId: native(input.nativeItemId) }),
      messageFromProviderItem: (input) =>
        base.derive.messageFromProviderItem({ ...input, nativeItemId: native(input.nativeItemId) }),
      turnItemFromProviderItem: (input) =>
        base.derive.turnItemFromProviderItem({
          ...input,
          nativeItemId: native(input.nativeItemId),
        }),
    },
  };
}
