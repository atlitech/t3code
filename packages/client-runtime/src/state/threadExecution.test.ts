import {
  TurnItemId,
  NodeId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  ProviderDriverKind,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  presentPendingBackgroundWork,
  pendingBackgroundWorkStatusLabel,
  deriveReportedModelSelection,
  deriveLatestThreadRun,
  deriveProviderSubagentStatus,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  presentRunStop,
  threadRuntimeHasInterruptibleRun,
} from "./threadExecution.ts";

const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");

describe("pendingBackgroundWorkStatusLabel", () => {
  it("names command waits without showing command text", () => {
    const command = { taskId: "build", kind: "command" as const, description: "npm run build" };
    expect(pendingBackgroundWorkStatusLabel([command])).toBe("Waiting on command");
    expect(pendingBackgroundWorkStatusLabel([command, { ...command, taskId: "test" }])).toBe(
      "Waiting on commands",
    );
    expect(
      pendingBackgroundWorkStatusLabel([command, { taskId: "review", kind: "subagent" }]),
    ).toBe("Waiting");
    expect(pendingBackgroundWorkStatusLabel([])).toBe("Waiting");
  });
});

function run(id: string, ordinal: number, status: OrchestrationV2RunStatus) {
  return {
    id: RunId.make(id),
    threadId: v2Projection.thread.id,
    ordinal,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

describe("thread execution presentation", () => {
  it("derives the current root failure without inheriting errors from children or previous runs", () => {
    const failed = { ...run("limited", 1, "failed"), rootNodeId: NodeId.make("root") };
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed], turnItems: [item] };
    expect(deriveThreadRuntime(projection)).toMatchObject({
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, nodeId: NodeId.make("child") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({
        ...projection,
        runs: [{ ...failed, rootNodeId: NodeId.make("new-root") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, run("new", 2, "running")] }),
    ).toMatchObject({ status: "running", lastError: null, lastErrorClass: null });
  });

  // regression: #15029 working timers no longer reset on every background wake
  it("counts a wake run's activity from the start of the work it continues", () => {
    const workStartedAt = DateTime.makeUnsafe("2026-07-28T09:20:00.000Z");
    const wake = { ...run("wake", 2, "running"), workStartedAt };
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "completed"), wake] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T09:20:00.000Z");
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "running")] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T10:00:00.000Z");
  });

  it("keeps a subscription limit visible while later messages stay queued", () => {
    const failed = {
      ...run("limited", 1, "failed"),
      rootNodeId: NodeId.make("root"),
      completedAt: now,
    };
    const queued = run("queued", 2, "queued");
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed, queued], turnItems: [item] };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "failed",
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    const cancelledQueued = {
      ...run("cancelled-queued", 3, "cancelled"),
      startedAt: null,
      completedAt: now,
    };
    expect(
      usageLimitBlockedRun([failed, queued, cancelledQueued], projection.turnItems, null)?.id,
    ).toBe(failed.id);
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, queued, cancelledQueued] }),
    ).toMatchObject({ status: "failed", lastErrorClass: "usage_limit" });
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, failure: { ...item.failure, class: "provider_error" as const } }],
      }),
    ).toMatchObject({ status: "queued", lastErrorClass: null });

    const otherProvider = ProviderInstanceId.make("claude-atli");
    expect(usageLimitBlockedRun(projection.runs, [item], null, otherProvider)).toBeNull();
    expect(usageLimitBlockedRun(projection.runs, [item], null, failed.providerInstanceId)?.id).toBe(
      failed.id,
    );
    const switched = {
      ...projection,
      thread: {
        ...projection.thread,
        providerInstanceId: otherProvider,
        modelSelection: { instanceId: otherProvider, model: "claude-opus" },
      },
    };
    // Choosing another account clears the old account's blocker without erasing its run.
    expect(deriveThreadRuntime({ ...switched, runs: [failed] })).toMatchObject({
      status: "idle",
      lastError: null,
      lastErrorClass: null,
    });
    const successful = {
      ...run("recovery", 4, "completed"),
      providerInstanceId: otherProvider,
      modelSelection: switched.thread.modelSelection,
      completedAt: DateTime.add(now, { minutes: 1 }),
    };
    expect(
      deriveThreadRuntime({ ...switched, runs: [failed, queued, cancelledQueued, successful] }),
    ).toMatchObject({ status: "completed", lastError: null, lastErrorClass: null });
    // A scheduled run submitted earlier can execute later on the new provider.
    // Its real limit must still stop work even though its ordinal is lower.
    const limitedSchedule = {
      ...queued,
      providerInstanceId: otherProvider,
      modelSelection: switched.thread.modelSelection,
      rootNodeId: NodeId.make("schedule-root"),
      status: "failed" as const,
      startedAt: successful.completedAt,
      completedAt: DateTime.add(now, { minutes: 2 }),
    };
    expect(
      deriveThreadRuntime({
        ...switched,
        runs: [failed, limitedSchedule, cancelledQueued, successful],
        turnItems: [
          item,
          {
            ...item,
            id: TurnItemId.make("new-limit"),
            runId: queued.id,
            nodeId: limitedSchedule.rootNodeId,
          },
        ],
      }),
    ).toMatchObject({ status: "failed", lastErrorClass: "usage_limit" });
  });

  it("keeps live activity attached to an executing run when a newer run is queued", () => {
    const runningRun = run("run-running", 1, "running");
    const queuedRun = run("run-queued", 2, "queued");
    const projection = { ...v2Projection, runs: [queuedRun, runningRun], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(queuedRun.id);
    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: runningRun.id,
      status: "running",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "running",
      activeRunId: runningRun.id,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });

  it("marks an open run whose provider turn already ended", () => {
    const attemptId = RunAttemptId.make("attempt-open");
    const openRun = { ...run("run-open", 1, "running"), activeAttemptId: attemptId };
    const providerTurn = (status: "running" | "failed") => ({
      id: ProviderTurnId.make("provider-turn-open"),
      providerThreadId: ProviderThreadId.make("provider-thread-open"),
      nodeId: NodeId.make("node-open"),
      runAttemptId: attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status,
      startedAt: now,
      completedAt: status === "running" ? null : now,
    });
    const projection = (status: "running" | "failed") => ({
      ...v2Projection,
      runs: [openRun],
      providerTurns: [providerTurn(status)],
      updatedAt: now,
    });

    expect(deriveThreadActivityRun(projection("running"))?.turnEnded).toBeUndefined();
    expect(deriveThreadActivityRun(projection("failed"))).toMatchObject({
      status: "running",
      turnEnded: true,
    });
  });

  it("presents a held queue as the stopped run instead of queued work", () => {
    const interrupted = { ...run("run-interrupted", 1, "interrupted"), completedAt: now };
    const held = { ...run("run-held", 2, "queued"), queueHeld: true };
    const projection = { ...v2Projection, runs: [interrupted, held], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "interrupted",
      activeRunId: null,
    });

    const resumed = { ...projection, runs: [interrupted, { ...held, queueHeld: false }] };
    expect(deriveThreadRuntime(resumed)).toMatchObject({ status: "queued" });

    const onlyHeld = {
      ...projection,
      runs: [held],
      thread: { ...projection.thread, activeProviderThreadId: null },
    };
    expect(deriveLatestThreadRun(onlyHeld)).toBeNull();
    expect(deriveThreadRuntime(onlyHeld)).toBeNull();
  });

  it("does not expose a queued-only run as interruptible", () => {
    const queuedRun = run("run-queued", 1, "queued");
    const projection = { ...v2Projection, runs: [queuedRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: queuedRun.id,
      status: "queued",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "queued",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });
});

describe("presentRunStop", () => {
  const signal = (type: "run_interrupt_request" | "run_interrupt_result", runId: RunId) => ({
    id: TurnItemId.make(`${type}:${runId}`),
    threadId: v2Projection.thread.id,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: type === "run_interrupt_result" ? ("interrupted" as const) : ("completed" as const),
    title: "Interrupt",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type,
    message: "Stopped by user",
  });
  const running = run("run-stopping", 1, "running");
  const request = signal("run_interrupt_request", running.id);

  it.each([
    { name: "no Stop", runs: [running], turnItems: [], state: null },
    {
      name: "a Stop the agent is winding down",
      runs: [running],
      turnItems: [request],
      state: "stopping",
    },
    {
      name: "a Stop the provider never confirmed",
      runs: [running],
      turnItems: [{ ...request, unresponsiveAt: now }],
      state: "unresponsive",
    },
    {
      name: "a Stop that ended the run",
      runs: [running],
      turnItems: [request, signal("run_interrupt_result", running.id)],
      state: null,
    },
    {
      name: "a settled run's background work still stopping",
      runs: [{ ...running, status: "completed" as const, completedAt: now }],
      turnItems: [request],
      state: null,
    },
    {
      name: "a settled run whose background work ignored Stop",
      runs: [{ ...running, status: "completed" as const, completedAt: now }],
      turnItems: [{ ...request, unresponsiveAt: now }],
      state: "unresponsive",
    },
    {
      name: "a settled run whose background work ignored Stop, with a queued follow-up",
      runs: [
        { ...running, status: "completed" as const, completedAt: now },
        run("run-queued", 2, "queued"),
      ],
      turnItems: [{ ...request, unresponsiveAt: now }],
      state: "unresponsive",
    },
  ])("presents $name", ({ runs, turnItems, state }) => {
    expect(presentRunStop({ runs, turnItems })?.state ?? null).toBe(state);
  });
});

describe("deriveRunlessWorkStartedAt", () => {
  const later = DateTime.makeUnsafe("2026-07-28T10:05:00.000Z");
  const rootTurn = (
    status: OrchestrationV2ExecutionNode["status"],
    startedAt = now,
  ): OrchestrationV2ExecutionNode => ({
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn",
    status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt,
    completedAt: null,
  });

  const nativeChild = {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource: "provider" as const,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
  };

  it("times a provider-native subagent from its runless root turn while it works", () => {
    const projection = { ...nativeChild, nodes: [rootTurn("running", later)] };
    expect(deriveRunlessWorkStartedAt(projection)).toBe("2026-07-28T10:05:00.000Z");
    expect(deriveThreadRuntime(projection)).toBeNull();
  });

  it("ignores root turns that belong to a run, and threads the provider does not run", () => {
    const owned = { ...rootTurn("running"), runId: RunId.make("run-1") };
    expect(deriveRunlessWorkStartedAt({ ...nativeChild, nodes: [owned] })).toBeNull();
    expect(
      deriveRunlessWorkStartedAt({ ...v2Projection, nodes: [rootTurn("running")] }),
    ).toBeNull();
  });
});

describe("deriveProviderSubagentStatus", () => {
  const root = {
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn" as const,
    status: "completed" as const,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: now,
  };
  const child = (creationSource: "provider" | "mcp") => ({
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
    nodes: [root],
  });

  it("leaves T3 delegated tasks and ordinary threads alone", () => {
    expect(deriveProviderSubagentStatus(child("mcp"))).toBeNull();
    expect(deriveProviderSubagentStatus({ ...v2Projection, nodes: [root] })).toBeNull();
  });
});

describe("presentPendingBackgroundWork", () => {
  it.each(["Subagent:", "Subagent:   "])(
    "falls back to the subagent noun when %s has no display name",
    (description) => {
      const presentation = presentPendingBackgroundWork([
        { taskId: "unnamed", kind: "subagent", description },
      ]);

      expect(presentation?.title).toBe("Waiting on a subagent");
      expect(presentation?.items[0]?.label).toBe("subagent");
    },
  );

  it.each([
    "/root/luna_window_properties",
    "Subagent: /root/luna_window_properties",
    "/root/parent/luna_window_properties",
  ])("uses the subagent display name for %s", (description) => {
    const childThreadId = ThreadId.make("thread:luna");
    const presentation = presentPendingBackgroundWork([
      { taskId: "luna", kind: "subagent", description, childThreadId },
    ]);

    expect(presentation).toEqual({
      title: "Waiting on subagent Luna Window Properties",
      items: [{ taskId: "luna", kind: "subagent", label: "Luna Window Properties", childThreadId }],
      waiting: true,
    });
  });

  it("formats subagent names in a mixed roster and preserves command descriptions", () => {
    const presentation = presentPendingBackgroundWork([
      { taskId: "cmd", kind: "command", description: "/root/run_tests" },
      { taskId: "luna", kind: "subagent", description: "/root/luna_window_properties" },
      { taskId: "review", kind: "subagent", description: "Review src/math.ts" },
    ]);

    expect(presentation?.title).toBe("Waiting on 2 subagents and 1 command");
    expect(presentation?.items.map((item) => item.label)).toEqual([
      "Luna Window Properties",
      "Review src/math.ts",
      "/root/run_tests",
    ]);
  });

  it("names a single piece of work by kind", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "a", kind: "subagent", description: "Review src/math.ts" },
      ])?.title,
    ).toBe("Waiting on subagent Review src/math.ts");
    expect(presentPendingBackgroundWork([{ taskId: "a", kind: "monitor" }])?.title).toBe(
      "Waiting on a monitor",
    );
    expect(presentPendingBackgroundWork([])).toBeNull();
  });

  it("waits for tracked commands after the root turn ends", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "dev", kind: "command", description: "Run the build" },
      ]),
    ).toMatchObject({ title: "Waiting on command Run the build", waiting: true });
    expect(presentPendingBackgroundWork([{ taskId: "a", kind: "command" }])).toMatchObject({
      title: "Waiting on a command",
      waiting: true,
    });
    expect(
      presentPendingBackgroundWork([
        { taskId: "a", kind: "command", description: "vp run build" },
        { taskId: "b", kind: "command", description: "vp test run" },
      ]),
    ).toMatchObject({ title: "Waiting on 2 commands", waiting: true });
    expect(
      presentPendingBackgroundWork([
        { taskId: "a", kind: "command", description: "vp run build" },
        { taskId: "b", kind: "monitor", description: "Watch PR checks" },
      ]),
    ).toMatchObject({ title: "Waiting on 1 command and 1 monitor", waiting: true });
  });

  it("groups work by kind, subagents first, and keeps each name", () => {
    const presentation = presentPendingBackgroundWork([
      { taskId: "cmd", kind: "command", description: "npm test" },
      {
        taskId: "b",
        kind: "subagent",
        description: "Write tests",
        childThreadId: ThreadId.make("thread:b"),
      },
      { taskId: "a", kind: "subagent", description: "Review src/math.ts" },
    ]);
    expect(presentation?.title).toBe("Waiting on 2 subagents and 1 command");
    expect(presentation?.items.map((item) => [item.kind, item.label, item.childThreadId])).toEqual([
      ["subagent", "Write tests", "thread:b"],
      ["subagent", "Review src/math.ts", undefined],
      ["command", "npm test", undefined],
    ]);
  });

  it("names generic work, including rosters from servers that predate kinds", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "bash", kind: "command", description: "Background sleep" },
        { taskId: "watch", kind: "monitor" },
        { taskId: "other", kind: "background_task" },
      ])?.title,
    ).toBe("Waiting on 1 command, 1 monitor and 1 background task");
    expect(presentPendingBackgroundWork([{ taskId: "old", kind: "background_task" }])?.title).toBe(
      "Waiting on a background task",
    );
  });
});

describe("provider-reported model selection", () => {
  const selected = v2Projection.thread.modelSelection;
  const reported = { ...selected, options: [{ id: "reasoningEffort", value: "default" }] };
  const providerThread = {
    id: ProviderThreadId.make("active"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: selected.instanceId,
    providerSessionId: ProviderSessionId.make("session"),
    appThreadId: v2Projection.thread.id,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    nativeMetadata: { modelSelection: reported },
  };
  const projection = {
    ...v2Projection,
    thread: { ...v2Projection.thread, activeProviderThreadId: providerThread.id },
    providerThreads: [providerThread],
  };

  it("reads only the active provider thread's reported selection", () => {
    expect(deriveReportedModelSelection(projection)).toBe(reported);
    expect(
      deriveReportedModelSelection({
        ...projection,
        thread: { ...projection.thread, activeProviderThreadId: null },
      }),
    ).toBeNull();
    expect(
      deriveReportedModelSelection({
        ...projection,
        providerThreads: [
          { ...providerThread, providerInstanceId: ProviderInstanceId.make("other") },
        ],
      }),
    ).toBeNull();
  });
});
