import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import {
  createInboxReturnTracker,
  isThreadWorking,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-1");

describe("commands in the Working section", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "returns to the inbox when the pending command becomes %s",
    (commandStatus) => {
      const runId = RunId.make("run-build");
      const command = {
        id: "command-build",
        type: "command_execution" as const,
        status: "running" as const,
        title: "Build the app",
        input: "vp run build",
      };
      const present = (status: typeof command.status | typeof commandStatus) =>
        presentThreadShell(environmentId, {
          ...v2ThreadShell,
          latestRunId: runId,
          status: "completed",
          pendingBackgroundTasks: derivePendingBackgroundWork({
            latestRun: { id: runId, ordinal: 1, status: "completed" },
            providerThreads: [],
            turnItems: [{ ...command, status }],
          }),
        });
      const running = present("running");
      const tracker = createInboxReturnTracker();
      tracker.observe([running]);

      expect(running.runtime?.status).toBe("idle");
      expect(isThreadWorking(running)).toBe(true);
      expect(tracker.returnedAt(running)).toBeUndefined();
      expect(isThreadWorking({ ...running, hasPendingApprovals: true })).toBe(false);
      expect(isThreadWorking({ ...running, hasPendingUserInput: true })).toBe(false);

      const finished = present(commandStatus);
      tracker.observe([finished]);
      expect(finished.pendingBackgroundTasks).toEqual([]);
      expect(isThreadWorking(finished)).toBe(false);
      expect(tracker.returnedAt(finished)).toBeDefined();
    },
  );
});

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();

    tracker.observe([thread("a", false), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeDefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
  });

  it("forgets deleted threads and resets when the beta turns off", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([thread("a", false), thread("b", false)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();

    tracker.observe(null);
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
    // After a reset the next call is a fresh baseline again.
    tracker.observe([thread("b", true)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      // A wake run requested after the other thread's send.
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    // Launched by an agent: no user message, so creation time is the send.
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});
