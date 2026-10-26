import { RegistryContext } from "@effect/atom-react";
import { claimThreadOpen } from "@t3tools/client-runtime/state/thread-search";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  visitRun: vi.fn(),
}));

const shellKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellAtom: ((ref: ScopedThreadRef) => shellAtom(shellKey(ref))) as never,
    },
    threadEnvironment: {
      ...actual.threadEnvironment,
      visit: { label: "visit", run: mocks.visitRun } as never,
    },
  };
});

import { ThreadVisitWatermark } from "./ThreadVisitWatermark";
import { BackgroundThreadContext } from "./backgroundThread";

// Kept alive so a shell set before its tracker mounts is still there when it does.
const shellAtom = Atom.family((_key: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));

const NOW = Date.parse("2026-01-04T00:00:00.000Z");
const ENVIRONMENT = EnvironmentId.make("environment-visit-watermark");
const threadA: ScopedThreadRef = { environmentId: ENVIRONMENT, threadId: ThreadId.make("a") };
const threadB: ScopedThreadRef = { environmentId: ENVIRONMENT, threadId: ThreadId.make("b") };

function setup() {
  mocks.visitRun.mockReset();
  mocks.visitRun.mockResolvedValue(AsyncResult.success(undefined));
  const registry = AtomRegistry.make();
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

function setShell(registry: AtomRegistry.AtomRegistry, ref: ScopedThreadRef, updatedAt: string) {
  registry.set(shellAtom(shellKey(ref)), {
    environmentId: ref.environmentId,
    id: ref.threadId,
    updatedAt,
    lastVisitedAt: "2026-01-01T00:00:00.000Z",
    latestRun: null,
  });
}

function visitedThreadIds() {
  return mocks.visitRun.mock.calls.map(
    ([, input]) => (input as { input: { threadId: string } }).input.threadId,
  );
}

it("records the visit of the next thread at once after switching threads", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  using fixture = setup();
  const { registry } = fixture;
  setShell(registry, threadA, "2026-01-02T00:00:00.000Z");
  setShell(registry, threadB, "2026-01-03T00:00:00.000Z");
  // A palette pick already sent B's open with its query, so B's visit is a plain watermark advance.
  claimThreadOpen(threadB.environmentId, threadB.threadId, NOW);

  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <ThreadVisitWatermark threadRef={threadA} />
    </RegistryContext.Provider>,
  );
  expect(visitedThreadIds()).toEqual(["a"]);

  await screen.rerender(
    <RegistryContext.Provider value={registry}>
      <ThreadVisitWatermark threadRef={threadB} />
    </RegistryContext.Provider>,
  );

  // Thread A's throttle must not hold back B's first watermark: leaving B
  // within the throttle window would otherwise keep it unread.
  expect(visitedThreadIds()).toEqual(["a", "b"]);
});

it("does not visit a covered thread and cancels its queued watermark", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  using fixture = setup();
  const { registry } = fixture;
  const ref = { environmentId: ENVIRONMENT, threadId: ThreadId.make("covered") };
  setShell(registry, ref, "2026-01-02T00:00:00.000Z");
  const view = (background: boolean) => (
    <RegistryContext.Provider value={registry}>
      <BackgroundThreadContext value={background}>
        <ThreadVisitWatermark threadRef={ref} />
      </BackgroundThreadContext>
    </RegistryContext.Provider>
  );
  await using screen = await render(view(true));
  expect(mocks.visitRun).not.toHaveBeenCalled();
  await screen.rerender(view(false));
  expect(visitedThreadIds()).toEqual(["covered"]);
  await act(() => setShell(registry, ref, "2026-01-03T00:00:00.000Z"));
  await screen.rerender(view(true));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(mocks.visitRun).toHaveBeenCalledOnce();
  await screen.rerender(view(false));
  expect(mocks.visitRun).toHaveBeenCalledTimes(2);
  expect(mocks.visitRun.mock.calls[1]?.[1]).toEqual({
    environmentId: ref.environmentId,
    input: { threadId: ref.threadId, visitedAt: "2026-01-03T00:00:00.000Z" },
  });
});
