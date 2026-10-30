import { expect, it, vi } from "vite-plus/test";
import { AsyncResult, Atom } from "effect/reactivity";
import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useThreadLifecycle } from "./useThreadLifecycle";
import { environmentThreadDetails } from "../../state/threads";

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({}),
  useAcknowledgeThreadWoke: () => vi.fn(),
}));
vi.mock("./useForceStopThread", () => ({ useForceStopThread: () => ({}) }));

function Harness({ saved }: { saved: boolean }) {
  const thread = makeThreadFixture();
  const ref = { environmentId: thread.environmentId, threadId: thread.id };
  useThreadLifecycle({
    environmentId: thread.environmentId,
    routeThreadKey: "draft",
    currentRouteThreadKeyRef: { current: "draft" },
    canOperateThread: false,
    clientSettingsHydrated: true,
    activeThread: thread,
    activeThreadId: thread.id,
    activeThreadRef: ref,
    activeThreadKey: "draft",
    activeThreadShell: saved ? thread : null,
    activeLatestRun: null,
    activeProjectCwd: null,
    serverConfig: null,
    runtimeMode: "full-access",
    isWorking: false,
    pendingBackgroundTasks: [],
    turnItems: [],
    activePendingApproval: null,
    activePendingUserInput: null,
    localCheckoutBranchMismatch: null,
    gitStatusQuery: { refresh: () => {} },
    nowMinute: "2026-10-30T16:06",
    composerRef: { current: null },
    composerDraftTarget: ref,
    sendInFlightRef: { current: false },
    setOptimisticUserMessages: () => {},
    setThreadError: () => {},
    clearUsageLimitsFor: () => {},
    beginLocalDispatch: () => {},
    resetLocalDispatch: () => {},
    scheduleComposerFocus: () => {},
    scrollToEnd: () => {},
    persistThreadSettingsForNextTurn: async () => AsyncResult.success(undefined),
  });
  return null;
}

it("does not load a draft's missing thread before its server shell arrives", async () => {
  const loadThread = vi.fn(() => null);
  using _runStop = vi
    .spyOn(environmentThreadDetails, "runStopAtom")
    .mockReturnValue(Atom.make(loadThread));
  await using screen = await render(
    <AppAtomRegistryProvider>
      <Harness saved={false} />
    </AppAtomRegistryProvider>,
  );
  expect(loadThread).not.toHaveBeenCalled();
  await screen.rerender(
    <AppAtomRegistryProvider>
      <Harness saved />
    </AppAtomRegistryProvider>,
  );
  expect(loadThread).toHaveBeenCalled();
});
