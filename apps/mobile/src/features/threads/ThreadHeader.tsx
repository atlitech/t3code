import { useMemo } from "react";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenHeaderButton } from "../../components/ui/ScreenHeaderButton";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";
import { useWorkspaceBackNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

export function ThreadHeader(
  props: Parameters<typeof useThreadHeaderOptions>[0] & {
    readonly hasThreadCwd: boolean;
    readonly hasWorkspaceRoot: boolean;
    readonly fileInspectorSupported: boolean;
    readonly inspectorMode: ThreadInspectorMode | null;
    readonly onToggleInspector: () => void;
    readonly onOpenGitInspector: () => void;
    readonly onOpenFilesInspector: () => void;
  },
) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout, panes, toggleAuxiliaryPane, composerKeyboardActive, startNewTask } =
    useAdaptiveWorkspaceLayout();
  const { onOpenTerminal, onMergeBack } = props.gitControls;
  const native = useThreadHeaderOptions(props);
  // iOS uses native header items. Android folds terminal and git into this menu
  // to avoid a second overflow button on narrow screens.
  const { threadActions, onThreadAction } = props;
  const threadActionsMenus = useMemo<ReadonlyArray<AppBarMenu>>(
    () => [
      {
        title: "Thread actions",
        icon: "ellipsis",
        items: [
          ...(props.hasWorkspaceRoot && props.gitControls.canOpenTerminal
            ? [
                {
                  id: "open-terminal",
                  title: "Open terminal",
                  icon: "terminal",
                  onPress: () => onOpenTerminal(null),
                },
              ]
            : []),
          {
            id: "open-git",
            title: "Git controls",
            icon: "point.topleft.down.curvedto.point.bottomright.up",
            subtitle: "Commit, files, branches",
            onPress: props.onOpenGitInspector,
          },
          ...(onMergeBack
            ? [
                {
                  id: "merge-back",
                  title: "Merge back to source",
                  icon: PullRequestGlyph.merged,
                  subtitle: "Bring this thread's latest turn into its source",
                  onPress: onMergeBack,
                },
              ]
            : []),
          ...(threadActions ?? []).map((action) => ({
            id: action.id,
            title: action.title,
            icon: action.icon,
            ...(action.subtitle ? { subtitle: action.subtitle } : {}),
            ...(action.disabled ? { disabled: true } : {}),
            ...(action.destructive ? { destructive: true } : {}),
            onPress: () => onThreadAction?.(action.id),
          })),
        ],
      },
    ],
    [
      onMergeBack,
      onOpenTerminal,
      onThreadAction,
      props.hasWorkspaceRoot,
      props.gitControls.canOpenTerminal,
      props.onOpenGitInspector,
      threadActions,
    ],
  );
  const androidHeaderActions = useMemo<ReadonlyArray<AppBarAction>>(() => {
    const actions: AppBarAction[] = [];
    if (props.onReturnToThread) {
      actions.push({
        accessibilityLabel: "Return to chat",
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      });
    }
    if (!props.draft && layout.usesSplitView && !panes.primarySidebarVisible) {
      actions.push({
        accessibilityLabel: "New task",
        icon: "square.and.pencil",
        onPress: startNewTask,
      });
    }
    if (props.hasThreadCwd) {
      const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
      actions.push({
        accessibilityLabel: filesVisible ? "Close files" : "Open files",
        selected: filesVisible,
        icon: "folder",
        onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
      });
    }
    return actions;
  }, [
    props.inspectorMode,
    props.draft,
    panes.auxiliaryPaneVisible,
    props.onOpenFilesInspector,
    toggleAuxiliaryPane,
    props.onReturnToThread,
    startNewTask,
    props.hasThreadCwd,
    layout.usesSplitView,
    panes.primarySidebarVisible,
  ]);

  return (
    <>
      <AppBar
        title={props.title}
        subtitle={props.subtitle}
        sidebar={native.sidebar}
        options={native.options}
        optionsVersion={native.optionsVersion}
        trailing={
          props.fileInspectorSupported && props.hasThreadCwd ? (
            <ScreenHeaderButton
              accessibilityLabel={
                props.inspectorMode !== null && panes.auxiliaryPaneVisible
                  ? "Hide inspector"
                  : "Show inspector"
              }
              icon="sidebar.right"
              selected={props.inspectorMode !== null && panes.auxiliaryPaneVisible}
              onPress={props.onToggleInspector}
            />
          ) : null
        }
        onBack={layout.usesSplitView ? undefined : goBack}
        actions={androidHeaderActions}
        menus={threadActionsMenus}
        hideBottomBorder
        compact={composerKeyboardActive}
      />
      {native.fallback}
    </>
  );
}
