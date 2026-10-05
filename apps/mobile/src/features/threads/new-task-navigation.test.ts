import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveNewTaskNavigationDestination,
  resolveSidebarSelectedThreadKey,
} from "./new-task-navigation";

function makeProject(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly title?: string;
}): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(input.environmentId),
    id: ProjectId.make(input.projectId),
    title: input.title ?? input.projectId,
    workspaceRoot: `/work/${input.projectId}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

describe("resolveNewTaskNavigationDestination", () => {
  it("opens the active thread's exact environment-scoped project", () => {
    const localProject = makeProject({
      environmentId: "local",
      projectId: "t3code",
      title: "T3 Code",
    });
    const remoteClone = makeProject({
      environmentId: "remote",
      projectId: "t3code",
      title: "T3 Code",
    });

    expect(
      resolveNewTaskNavigationDestination({
        projects: [remoteClone, localProject],
        hasActiveThreadRoute: true,
        activeThread: {
          environmentId: localProject.environmentId,
          projectId: localProject.id,
        },
      }),
    ).toEqual({ kind: "draft", project: localProject });
  });

  it("falls back to the picker when the active project is stale", () => {
    const onlyAvailableProject = makeProject({
      environmentId: "remote",
      projectId: "replacement",
      title: "T3 Code",
    });

    expect(
      resolveNewTaskNavigationDestination({
        projects: [onlyAvailableProject],
        hasActiveThreadRoute: true,
        activeThread: {
          environmentId: EnvironmentId.make("local"),
          projectId: ProjectId.make("removed"),
        },
      }),
    ).toEqual({ kind: "picker" });
  });

  it("does not infer an active project from a matching title", () => {
    const sameTitle = makeProject({
      environmentId: "local",
      projectId: "different-project",
      title: "T3 Code",
    });

    expect(
      resolveNewTaskNavigationDestination({
        projects: [sameTitle],
        hasActiveThreadRoute: true,
        activeThread: {
          environmentId: sameTitle.environmentId,
          projectId: ProjectId.make("missing-project"),
        },
      }),
    ).toEqual({ kind: "picker" });
  });

  it("skips the picker only when no thread is active and one project is unambiguous", () => {
    const project = makeProject({ environmentId: "local", projectId: "t3code" });

    expect(
      resolveNewTaskNavigationDestination({
        projects: [project],
        hasActiveThreadRoute: false,
        activeThread: null,
      }),
    ).toEqual({ kind: "draft", project });
    expect(
      resolveNewTaskNavigationDestination({
        projects: [project, makeProject({ environmentId: "remote", projectId: "another-project" })],
        hasActiveThreadRoute: false,
        activeThread: null,
      }),
    ).toEqual({ kind: "picker" });
    expect(
      resolveNewTaskNavigationDestination({
        projects: [],
        hasActiveThreadRoute: false,
        activeThread: null,
      }),
    ).toEqual({ kind: "picker" });
  });

  it("keeps the picker when a thread route is active but its shell has not resolved", () => {
    const project = makeProject({ environmentId: "local", projectId: "t3code" });

    expect(
      resolveNewTaskNavigationDestination({
        projects: [project],
        hasActiveThreadRoute: true,
        activeThread: null,
      }),
    ).toEqual({ kind: "picker" });
  });
});

describe("resolveSidebarSelectedThreadKey", () => {
  const selectedThreadKey = "local:thread-1";

  it.each([
    {
      name: "Android split workspace while new-task flow is presented",
      input: {
        selectedThreadKey,
        newTaskFlowPresented: true,
        usesSplitView: true,
        isAndroid: true,
      },
      expected: null,
    },
    {
      name: "Android split workspace after new-task flow closes",
      input: {
        selectedThreadKey,
        newTaskFlowPresented: false,
        usesSplitView: true,
        isAndroid: true,
      },
      expected: selectedThreadKey,
    },
    {
      name: "Android compact workspace while new-task flow is presented",
      input: {
        selectedThreadKey,
        newTaskFlowPresented: true,
        usesSplitView: false,
        isAndroid: true,
      },
      expected: selectedThreadKey,
    },
    {
      name: "iOS split workspace while its sheet is presented",
      input: {
        selectedThreadKey,
        newTaskFlowPresented: true,
        usesSplitView: true,
        isAndroid: false,
      },
      expected: selectedThreadKey,
    },
  ])("returns the expected selection for $name", ({ input, expected }) => {
    expect(resolveSidebarSelectedThreadKey(input)).toBe(expected);
  });

  it("keeps an empty selection empty in every presentation state", () => {
    expect(
      resolveSidebarSelectedThreadKey({
        selectedThreadKey: null,
        newTaskFlowPresented: true,
        usesSplitView: true,
        isAndroid: true,
      }),
    ).toBeNull();
  });
});
