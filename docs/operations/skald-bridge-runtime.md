# Dedicated Skald bridge runtime

This profile confines Codex execution in a separate Linux T3 service. Ordinary T3 installations retain their existing behavior. This change does not issue bridge bindings or activate a Skald dispatcher.

An administrator must allocate an exclusive non-login custody UID/GID to this service. No interactive shell, other service, unrestricted process, or writable executable/configuration may use that identity. This allocation is a deployment trust boundary; a `/proc` scan is only a check for an already violated allocation. Do not enable this profile on a desktop or interactive development server.

Install the T3 server and its dependencies in a root-owned tree with no group/other writable files. Install bubblewrap 0.11.1 without setuid/setgid and compile the trusted supervisor from [bridge-supervisor.c](../../apps/server/bridge-tools/bridge-supervisor.c), for example with `cc -O2 -Wall -Wextra -Werror bridge-supervisor.c -o bridge-supervisor`. Install that binary root-owned and executable. Use an immutable runtime image containing Node, Codex CLI 0.162.0, the required shared libraries, and minimal `etc` configuration. Symlinks must resolve within that image. No host home, credentials, control socket, or server state belongs in the image.

Create separate custody-owned mode-0700 workspace and state roots under operator-owned parents. Workspaces must be canonical standalone directories beneath the workspace root; linked Git worktrees, shared object stores, submodules and nested/concurrent workspace leases are unsupported. Each durable thread has an exclusive private runtime home; two simultaneous sessions cannot share it. Each session owns its own namespace and proxy socket.

Set `T3CODE_BRIDGE_PROFILE` in the administrator-owned systemd unit to an absolute root-owned JSON file:

```json
{
  "custodyUid": 991,
  "custodyGid": 991,
  "exclusiveCustodyUid": true,
  "serviceUnit": "/etc/systemd/system/t3-bridge.service",
  "cgroup": "/system.slice/t3-bridge.service",
  "installedRoot": "/opt/t3-bridge/server",
  "runtimeRoot": "/opt/t3-bridge/runtime",
  "workspaceRoot": "/srv/t3-bridge-workspaces",
  "stateRoot": "/var/lib/t3-bridge",
  "bwrapPath": "/usr/bin/bwrap",
  "supervisorPath": "/opt/t3-bridge/bridge-supervisor",
  "codexPath": "/runtime/usr/bin/codex"
}
```

Run the server directly under systemd with `User=<the custody account name>`, `KillMode=control-group`, and `NoNewPrivileges=yes`, with no unit overrides, drop-ins or environment files. The service requires the expected direct systemd ancestry and cgroup, a non-login passwd entry, immutable operator deployment, and working unprivileged namespaces. Start web mode on loopback with browser launch disabled. Development, desktop, remote/relay/tunnel modes are refused. Admission happens before login-shell PATH resolution or provider probes. Startup performs an actual namespace and Codex-version probe and reports `BridgeIsolationUnavailable` on failure. This is not admission based solely on a feature flag.

Only Codex instances using the installed runtime are supported. Managed runtimes, access-token overlays, shared host login, custom executable/arguments/environment, runtime hooks, and other providers (including Pi, Muse, ACP and native SDKs) are refused. Sign in from inside the admitted runtime only, using the private Codex file credential store; do not copy a host `auth.json` or OAuth token into it. Credentials persist only in that thread's private home. Runtime login requires provider endpoint compatibility with the deliberately narrow egress policy; no host credential fallback exists.

Codex uses the outer confinement with its supported HTTP Responses transport. Workspace-write and full-access requests remain bounded by the same private namespace and workspace mount. Read-only or other incompatible native sandbox policies are refused rather than changed to writable access. Interactive approval policy remains in force. Ordinary T3 MCP credentials and per-instance sharing of Codex threads are disabled.

The namespace has private user, PID, mount, network, IPC, UTS and cgroup namespaces, drops all capabilities, and disables nested user namespaces. It sees only its workspace, private home, synthetic `/proc` and `/dev`, read-only runtime/helper and its own Unix egress socket. Environment and file descriptors are explicitly limited. The trusted supervisor also denies `keyctl`, `add_key` and `request_key` through inherited seccomp, including incompatible and x32 ABI paths: Linux keyrings otherwise survive namespace isolation.

The credential-free CONNECT proxy accepts only `api.openai.com:443`, `chatgpt.com:443` and `auth.openai.com:443`. It resolves once, rejects private/reserved/host addresses, and connects a validated public IPv4 literal. It cannot reach host loopback services, Unix/abstract control sockets, arbitrary Internet hosts or DNS rebinding targets. A read-only Node helper supplies a loopback HTTP proxy inside the private network. Actual Codex 0.162.0 app-server initialization and turn submission were observed issuing CONNECT for a synthetic Responses endpoint; real OAuth/TLS traffic is not part of the synthetic tests. Startup GitHub/plugin catalog requests are denied; GitHub is not an allowed provider endpoint.

Host execution through Effect process spawning, Git hooks/filters/checkpoints, PTYs/setup scripts, provider maintenance/auth/install/background generation, native SDKs, Playwright/browser/device/remote launchers, shell resolution and ACP shims is refused before invocation. Host-backed media/draft asset issuance is also refused to prevent model-authored paths from reading custody files through the client. Native provider IDs are scoped to the trusted thread so another app-server cannot overwrite its records. The persisted provider failure envelope retains a `BridgeIsolationUnavailable:<reason>` code for session refusal.

Shutdown uses pidfds for both the owned bubblewrap child and namespace init, acquired behind its pre-exec block barrier. The supervisor is a subreaper and does not report completion until every adopted descendant is reaped; workspace/home leases release only afterward. Cleanup targets recorded session resources, never process names or arbitrary numeric PIDs. If the supervisor loses ownership unexpectedly, the service refuses further opens and retains leases/control records until a restart passes topology/quiescence admission. Stale control cleanup accepts only directories recorded under an absent prior owner; it is not a broad state-directory sweep.

Focused native tests exercise two simultaneous real namespaces, synthetic host secrets, environment/proc/fd/socket and sibling probes, bounded positive workspace/protocol behavior, read-only runtime, keyring denial, detached descendants, failure/restart and parent death. Interactive test topology is deliberately separate from production service admission. A host without working prerequisites must assert typed refusal rather than claim a passing OS isolation test.
