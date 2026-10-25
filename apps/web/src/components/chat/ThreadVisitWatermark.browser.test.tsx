import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { useUiStateStore } from "../../uiStateStore";
import { BackgroundThreadContext } from "./backgroundThread";
import { ThreadVisitWatermark } from "./ThreadVisitWatermark";

const state = vi.hoisted(() => ({
  updatedAt: "2026-10-25T00:00:01.000Z",
  supportsVisits: true,
  visit: vi.fn(),
  claimOpen: vi.fn(() => true),
}));
const threadRef = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("visit") };
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: (() => ({
    ...makeThreadFixture(),
    id: threadRef.threadId,
    environmentId: threadRef.environmentId,
    updatedAt: state.updatedAt,
    lastVisitedAt: state.supportsVisits ? null : undefined,
    latestRun: null,
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.visit) as never,
}));
vi.mock(import("@t3tools/client-runtime/state/thread-search"), async (original) => ({
  ...(await original()),
  claimThreadOpen: state.claimOpen,
}));

function view(background: boolean) {
  return (
    <BackgroundThreadContext value={background}>
      <ThreadVisitWatermark threadRef={threadRef} />
    </BackgroundThreadContext>
  );
}
function reset() {
  state.updatedAt = "2026-10-25T00:00:01.000Z";
  state.visit.mockReset();
  state.claimOpen.mockClear();
  const previous = useUiStateStore.getState().threadLastVisitedAtById;
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  return {
    [Symbol.dispose]: () => useUiStateStore.setState({ threadLastVisitedAtById: previous }),
  };
}

it.each([true, false])(
  "does not record a covered thread (server visits: %s)",
  async (supported) => {
    using _state = reset();
    state.supportsVisits = supported;
    await using screen = await render(view(true), { router: false });
    state.updatedAt = "2026-10-25T00:00:02.000Z";
    await screen.rerender(view(true));
    expect(state.visit).not.toHaveBeenCalled();
    expect(state.claimOpen).not.toHaveBeenCalled();
    expect(
      useUiStateStore.getState().threadLastVisitedAtById[scopedThreadKey(threadRef)],
    ).toBeUndefined();

    await screen.rerender(view(false));
    if (supported) {
      expect(state.visit).toHaveBeenCalledWith({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, visitedAt: state.updatedAt, opened: true },
      });
    } else {
      expect(useUiStateStore.getState().threadLastVisitedAtById[scopedThreadKey(threadRef)]).toBe(
        state.updatedAt,
      );
    }
  },
);

it("cancels a queued visit under the modal and resumes without counting another open", async () => {
  using _state = reset();
  state.supportsVisits = true;
  using _timers = fakeTimers();
  vi.setSystemTime(new Date("2026-10-25T00:00:10.000Z"));
  await using screen = await render(view(false), { router: false });
  expect(state.visit).toHaveBeenCalledOnce();
  state.visit.mockClear();

  state.updatedAt = "2026-10-25T00:00:02.000Z";
  await screen.rerender(view(false));
  await screen.rerender(view(true));
  await act(() => vi.advanceTimersByTime(10_000));
  expect(state.visit).not.toHaveBeenCalled();

  await screen.rerender(view(false));
  expect(state.visit).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, visitedAt: state.updatedAt },
  });
  expect(state.claimOpen).toHaveBeenCalledOnce();
});
