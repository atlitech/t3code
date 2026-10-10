import { ChildProcess } from "effect/process";

export interface NamespaceLaunchInput {
  readonly bwrapPath: string;
  readonly runtimeRoot: string;
  readonly workspace: string;
  readonly home: string;
  readonly proxySocket: string;
  readonly helperPath: string;
  /** Absolute path inside the trusted runtime image, e.g. /runtime/usr/bin/codex. */
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

/** The same namespace boundary is used by production Codex and native probes. */
export function buildNamespaceCommand(input: NamespaceLaunchInput) {
  return ChildProcess.make(
    input.bwrapPath,
    [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup",
      "--disable-userns",
      "--assert-userns-disabled",
      "--die-with-parent",
      "--as-pid-1",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--hostname",
      "t3-runtime",
      "--ro-bind",
      input.runtimeRoot,
      "/runtime",
      "--symlink",
      "runtime/usr",
      "/usr",
      "--symlink",
      "runtime/lib",
      "/lib",
      "--symlink",
      "runtime/lib64",
      "/lib64",
      "--symlink",
      "usr/bin",
      "/bin",
      "--ro-bind",
      `${input.runtimeRoot}/etc`,
      "/etc",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/home",
      "--bind",
      input.home,
      "/home/runtime",
      "--bind",
      input.workspace,
      input.workspace,
      "--dir",
      "/bridge",
      "--ro-bind",
      input.proxySocket,
      "/bridge/egress.sock",
      "--ro-bind",
      input.helperPath,
      "/bridge/helper.cjs",
      "--setenv",
      "HOME",
      "/home/runtime",
      "--setenv",
      "CODEX_HOME",
      "/home/runtime/.codex",
      "--setenv",
      "PATH",
      "/runtime/usr/bin:/usr/bin:/bin",
      "--setenv",
      "LANG",
      "C.UTF-8",
      "--setenv",
      "HTTPS_PROXY",
      "http://127.0.0.1:18080",
      "--setenv",
      "HTTP_PROXY",
      "http://127.0.0.1:18080",
      "--chdir",
      input.workspace,
      "--",
      "/runtime/usr/bin/node",
      "/bridge/helper.cjs",
      input.executable,
      ...input.args,
    ],
    { env: {}, extendEnv: false, shell: false, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
}

// Installed read-only in each namespace. The helper only relays bytes to its
// session's Unix socket; target authorization stays in the custody process.
export const namespaceHelperSource = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
const sockets = new Set();
const server = net.createServer({ maxConnections: 32 }, client => {
  const upstream = net.connect('/bridge/egress.sock');
  sockets.add(client); sockets.add(upstream);
  const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
  client.on('error', close); upstream.on('error', close);
  client.on('close', close); upstream.on('close', close);
  client.setTimeout(120000, close); upstream.setTimeout(120000, close);
  client.pipe(upstream); upstream.pipe(client);
});
server.maxConnections = 32;
server.on('error', () => process.exit(125));
server.listen(18080, '127.0.0.1', () => {
  const child = spawn(process.argv[2], process.argv.slice(3), {
    stdio: ['inherit', 'inherit', 'inherit'], env: process.env, shell: false,
  });
  child.on('error', () => process.exit(125));
  child.on('exit', (code, signal) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(code === null ? 128 : code));
  });
});
`;
