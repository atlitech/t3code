import { describe, expect, it } from "vite-plus/test";

import { shouldCommitThreadFullSwipe } from "./thread-swipe-commit";

describe("shouldCommitThreadFullSwipe", () => {
  const activeGesture = {
    armed: true,
    currentResetKey: "environment:current-thread",
    gestureResetKey: "environment:current-thread",
    gestureStartedAtMs: 1_000,
    nowMs: 1_500,
  } as const;

  it("commits an armed action from the current fresh gesture", () => {
    expect(shouldCommitThreadFullSwipe(activeGesture)).toBe(true);
  });

  it("does not commit when native row state opens without a user gesture", () => {
    expect(
      shouldCommitThreadFullSwipe({
        ...activeGesture,
        gestureStartedAtMs: null,
      }),
    ).toBe(false);
  });

  it("does not commit armed state recycled from another thread", () => {
    expect(
      shouldCommitThreadFullSwipe({
        ...activeGesture,
        currentResetKey: "environment:next-thread",
      }),
    ).toBe(false);
  });

  it("does not commit a gesture retained across an app pause", () => {
    expect(
      shouldCommitThreadFullSwipe({
        ...activeGesture,
        nowMs: 7_001,
      }),
    ).toBe(false);
  });

  it("does not commit a clock-skewed gesture timestamp", () => {
    expect(
      shouldCommitThreadFullSwipe({
        ...activeGesture,
        nowMs: 999,
      }),
    ).toBe(false);
  });
});
