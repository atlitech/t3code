// @effect-diagnostics nodeBuiltinImport:off -- Exercises the changed-file CLI with real Node test subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

it.each([
  { fails: false, filename: "example.test.cjs", untracked: false },
  { fails: true, filename: "example.test.cjs", untracked: false },
  { fails: true, filename: "café.test.cjs", untracked: true },
  { fails: true, filename: "日本語.test.cjs", untracked: false },
])(
  "reports failure=$fails for $filename (untracked=$untracked)",
  async ({ fails, filename, untracked }) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-"));
    try {
      const testPath = `.github/scripts/${filename}`;
      await NodeFSP.mkdir(NodePath.join(root, "scripts"));
      await NodeFSP.mkdir(NodePath.join(root, ".github/scripts"), { recursive: true });
      await NodeFSP.copyFile(
        NodePath.join(import.meta.dirname, "check-changed.ts"),
        NodePath.join(root, "scripts/check-changed.ts"),
      );
      await NodeFSP.writeFile(
        NodePath.join(root, ".github/scripts/ci-changes.cjs"),
        "exports.readWorkspace = () => []; exports.decide = () => ({ affected: [], outputs: {} });",
      );
      await NodeFSP.writeFile(
        NodePath.join(root, testPath),
        `const test = require('node:test');
test('node runner fixture', () => { ${fails ? "throw new Error('fixture failure');" : ""} });`,
      );
      // Preload command stubs in this child only; no shell or executable scripts are needed.
      const preload = NodePath.join(root, "commands.mjs");
      await NodeFSP.writeFile(
        preload,
        `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const { spawnSync, execFileSync } = childProcess;
childProcess.execFileSync = (command, args, options) => {
  if (command !== 'git') return execFileSync(command, args, options);
  if (args[0] !== ${JSON.stringify(untracked ? "ls-files" : "diff")}) return '';
  const file = ${JSON.stringify(testPath)};
  const quoted = ${JSON.stringify(filename === "example.test.cjs" ? testPath : JSON.stringify(testPath))};
  return args.includes('-z') ? file + '\\0' : quoted + '\\n';
};
childProcess.spawnSync = (command, args, options) => {
  if (command === 'git') return { status: 0, stdout: '0123456789012345678901234567890123456789' };
  if (command !== 'vp') return spawnSync(command, args, options);
  return args[0] === 'exec' && args[1] === 'node'
    ? spawnSync(process.execPath, args.slice(2), options)
    : { status: 0 };
};
syncBuiltinESMExports();`,
      );

      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--import",
          NodeURL.pathToFileURL(preload).href,
          NodePath.join(root, "scripts/check-changed.ts"),
          "HEAD",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, PATH: "" },
        },
      );
      expect(result.stdout).toContain("node runner fixture");
      expect(result.status, result.stderr).toBe(fails ? 1 : 0);
      if (fails) expect(result.stdout).toContain("fixture failure");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
