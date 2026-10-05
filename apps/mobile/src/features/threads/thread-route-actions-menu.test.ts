import { describe, expect, it } from "vite-plus/test";

import { buildThreadRouteActionMenu } from "./thread-route-actions-menu";

describe("buildThreadRouteActionMenu", () => {
  it("offers settle and a destructive delete for active threads", () => {
    expect(
      buildThreadRouteActionMenu({
        settlementSupported: true,
        settled: false,
        settleable: true,
        worktreeBranch: null,
      }),
    ).toEqual([
      { id: "settle", title: "Settle", icon: "checkmark" },
      { id: "delete", title: "Delete", icon: "trash", destructive: true },
    ]);
  });

  it("disables settle while the thread still needs attention", () => {
    expect(
      buildThreadRouteActionMenu({
        settlementSupported: true,
        settled: false,
        settleable: false,
        worktreeBranch: null,
      })[0],
    ).toMatchObject({
      id: "settle",
      disabled: true,
      subtitle: "Available when this thread no longer needs attention",
    });
  });

  it("offers un-settle for a settled thread", () => {
    expect(
      buildThreadRouteActionMenu({
        settlementSupported: true,
        settled: true,
        settleable: true,
        worktreeBranch: null,
      })[0],
    ).toEqual({ id: "unsettle", title: "Un-settle", icon: "arrow.uturn.backward" });
  });

  it("keeps delete available for servers without settlement support", () => {
    expect(
      buildThreadRouteActionMenu({
        settlementSupported: false,
        settled: false,
        settleable: true,
        worktreeBranch: null,
      }),
    ).toEqual([{ id: "delete", title: "Delete", icon: "trash", destructive: true }]);
  });

  it("offers a new thread on the current worktree before lifecycle actions", () => {
    expect(
      buildThreadRouteActionMenu({
        settlementSupported: true,
        settled: false,
        settleable: true,
        worktreeBranch: "feature/mobile-actions",
      })[0],
    ).toEqual({
      id: "new-thread-on-worktree",
      title: "New thread on this worktree",
      subtitle: "feature/mobile-actions",
      icon: "arrow.branch",
    });
  });
});
