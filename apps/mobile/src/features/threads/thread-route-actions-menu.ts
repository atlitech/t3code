export type ThreadRouteActionId = "new-thread-on-worktree" | "settle" | "unsettle" | "delete";

export type ThreadRouteActionMenuItem = {
  readonly id: ThreadRouteActionId;
  readonly title: string;
  readonly icon: "arrow.branch" | "checkmark" | "arrow.uturn.backward" | "trash";
  readonly subtitle?: string;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
};

export function buildThreadRouteActionMenu(input: {
  readonly settlementSupported: boolean;
  readonly settled: boolean;
  readonly settleable: boolean;
  readonly worktreeBranch: string | null;
}): ThreadRouteActionMenuItem[] {
  const newThreadAction: ThreadRouteActionMenuItem[] = input.worktreeBranch
    ? [
        {
          id: "new-thread-on-worktree",
          title: "New thread on this worktree",
          subtitle: input.worktreeBranch,
          icon: "arrow.branch",
        },
      ]
    : [];
  const settlementAction: ThreadRouteActionMenuItem[] = !input.settlementSupported
    ? []
    : input.settled
      ? [{ id: "unsettle", title: "Un-settle", icon: "arrow.uturn.backward" }]
      : [
          {
            id: "settle",
            title: "Settle",
            icon: "checkmark",
            ...(!input.settleable
              ? {
                  disabled: true,
                  subtitle: "Available when this thread no longer needs attention",
                }
              : {}),
          },
        ];

  return [
    ...newThreadAction,
    ...settlementAction,
    {
      id: "delete",
      title: "Delete",
      icon: "trash",
      destructive: true,
    },
  ];
}
