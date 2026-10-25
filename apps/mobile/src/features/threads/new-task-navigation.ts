import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

export type NewTaskNavigationDestination =
  | { readonly kind: "draft"; readonly project: EnvironmentProject }
  | { readonly kind: "picker" };

/**
 * Stale thread context must open the picker, never retarget a similarly named project.
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
