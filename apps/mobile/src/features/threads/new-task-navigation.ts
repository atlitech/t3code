import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

export type NewTaskNavigationDestination =
  | { readonly kind: "draft"; readonly project: EnvironmentProject }
  | { readonly kind: "picker" };

/**
 * Resolve the smallest safe new-task flow for an expanded workspace.
 *
 * A thread's project is only usable when both its environment and project id
 * still exist in the local catalog. If that context is stale, choosing a
 * similarly named project (or the sole project on another machine) would
 * silently retarget the task, so the user must pick instead.
 */
export function resolveNewTaskNavigationDestination(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly hasActiveThreadRoute: boolean;
  readonly activeThread: Pick<EnvironmentThreadShell, "environmentId" | "projectId"> | null;
}): NewTaskNavigationDestination {
  if (input.hasActiveThreadRoute) {
    const activeProject = input.projects.find(
      (project) =>
        project.environmentId === input.activeThread?.environmentId &&
        project.id === input.activeThread?.projectId,
    );
    return activeProject ? { kind: "draft", project: activeProject } : { kind: "picker" };
  }

  const onlyProject = input.projects.length === 1 ? input.projects[0] : null;
  return onlyProject ? { kind: "draft", project: onlyProject } : { kind: "picker" };
}

/** Keep the sidebar's visual selection aligned with the content pane. */
export function resolveSidebarSelectedThreadKey(input: {
  readonly selectedThreadKey: string | null;
  readonly newTaskFlowPresented: boolean;
  readonly usesSplitView: boolean;
  readonly isAndroid: boolean;
}): string | null {
  return input.isAndroid && input.usesSplitView && input.newTaskFlowPresented
    ? null
    : input.selectedThreadKey;
}
