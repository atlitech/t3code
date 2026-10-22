import { assert, it, vi } from "@effect/vitest";
import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";

function projectionWithRuntimeRequest(
  runtimeRequest?: OrchestrationV2RuntimeRequest,
): OrchestrationV2ThreadProjection {
  return {
    runtimeRequests: runtimeRequest === undefined ? [] : [runtimeRequest],
  } as unknown as OrchestrationV2ThreadProjection;
}

function resolvedRuntimeRequest(
  requestId: RuntimeRequestId,
  providerSessionId: ProviderSessionId,
): OrchestrationV2RuntimeRequest {
  return {
    id: requestId,
    nodeId: NodeId.make(`node-${requestId}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "resolved",
    responseCapability: {
      type: "live",
      providerSessionId,
    },
    createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
    resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
  };
}

function layerRuntimeRequestTest(
  projection: OrchestrationV2ThreadProjection,
  getSession: ProviderSessionManager.ProviderSessionManagerV2["Service"]["get"],
) {
  return RuntimeRequestService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRequest: (_threadId, requestId) =>
            Effect.succeed(projection.runtimeRequests.find((request) => request.id === requestId)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );
}

it.effect("rejects expired runtime requests before invoking the live adapter", () => {
  const threadId = ThreadId.make("thread-runtime-request-expired");
  const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-expired");
  const requestId = RuntimeRequestId.make("request-expired");
  const respondToRuntimeRequest = vi.fn(
    (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
  );
  const getSession = vi.fn(() =>
    Effect.succeed(
      Option.some({
        respondToRuntimeRequest,
      } as never),
    ),
  );
  const projection = {
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make("node-runtime-request-expired"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "expired",
        responseCapability: {
          type: "live",
          providerSessionId,
        },
        createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
        resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = RuntimeRequestService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRequest: (_threadId, requestId) =>
            Effect.succeed(projection.runtimeRequests.find((request) => request.id === requestId)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const error = yield* service
      .respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "accept",
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "request-not-ready");
    assert.equal(
      error.message,
      `Runtime request ${requestId} on thread ${threadId} is not ready for response execution.`,
    );
    assert.isUndefined(error.cause);
    assert.equal(getSession.mock.calls.length, 0);
    assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

it.effect("completes queued responses when the MCP provider already cancelled the request", () => {
  const threadId = ThreadId.make("thread-cancelled-elicitation");
  const providerSessionId = ProviderSessionId.make("session-cancelled-elicitation");
  const requestId = RuntimeRequestId.make("request-cancelled-elicitation");
  const getSession = vi.fn(() => Effect.succeed(Option.none()));
  const layerTest = layerRuntimeRequestTest(
    projectionWithRuntimeRequest({
      ...resolvedRuntimeRequest(requestId, providerSessionId),
      kind: "mcp-elicitation",
      status: "cancelled",
      decision: "cancel",
    }),
    getSession,
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    yield* service.respond({ threadId, providerSessionId, requestId, decision: "accept" });
    // No live callback remains, including when its entire provider session has closed.
    assert.equal(getSession.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

it.effect.each([
  {
    kind: "mcp-elicitation",
    status: "cancelled",
    capability: "wrong-session",
    reason: "request-not-resumable",
  },
  {
    kind: "mcp-elicitation",
    status: "cancelled",
    capability: "not-resumable",
    reason: "request-not-resumable",
  },
  { kind: "mcp-elicitation", status: "expired", capability: "live", reason: "request-not-ready" },
  { kind: "mcp-elicitation", status: "pending", capability: "live", reason: "request-not-ready" },
  { kind: "command", status: "cancelled", capability: "live", reason: "request-not-ready" },
] as const)(
  "rejects $kind $status responses with $capability capability",
  ({ kind, status, capability, reason }) => {
    const threadId = ThreadId.make("thread-invalid-elicitation");
    const providerSessionId = ProviderSessionId.make("session-invalid-elicitation");
    const requestId = RuntimeRequestId.make("request-invalid-elicitation");
    const getSession = vi.fn(() => Effect.succeed(Option.none()));
    const layerTest = layerRuntimeRequestTest(
      projectionWithRuntimeRequest({
        ...resolvedRuntimeRequest(requestId, providerSessionId),
        kind,
        status,
        responseCapability:
          capability === "not-resumable"
            ? { type: "not_resumable", reason: "The provider session ended." }
            : {
                type: "live",
                providerSessionId:
                  capability === "wrong-session"
                    ? ProviderSessionId.make("another-session")
                    : providerSessionId,
              },
      }),
      getSession,
    );
    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      const error = yield* service
        .respond({ threadId, providerSessionId, requestId, decision: "accept" })
        .pipe(Effect.flip);
      assert.equal(error.reason, reason);
      assert.equal(getSession.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  },
);
