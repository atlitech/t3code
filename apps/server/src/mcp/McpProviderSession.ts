import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /**
   * False when the environment turned pull request watching off. Refreshed
   * from the live setting before each turn; adapters read it through
   * `pullRequestWatchAvailable` so the prompt does not tell agents to use a
   * watcher every call would refuse. Absent means available.
   */
  readonly pullRequestWatchAvailable?: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

/** Records the live watch setting on the thread's MCP config; a no-op without one. */
export function setPullRequestWatchAvailable(threadId: ThreadId, available: boolean): void {
  const existing = sessionsByThread.get(threadId);
  if (existing === undefined || existing.pullRequestWatchAvailable === available) return;
  sessionsByThread.set(threadId, { ...existing, pullRequestWatchAvailable: available });
}

/** Whether the thread's agent may be told to use `watch_pull_request`. */
export function pullRequestWatchAvailable(threadId: ThreadId | null): boolean {
  if (threadId === null) return true;
  return sessionsByThread.get(threadId)?.pullRequestWatchAvailable !== false;
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
