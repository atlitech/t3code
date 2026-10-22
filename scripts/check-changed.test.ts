// @effect-diagnostics nodeBuiltinImport:off -- Exercises the changed-file CLI with real Node test subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it.each([
  { fails: false, filename: "example.test.cjs", untracked: false },
  { fails: true, filename: "example.test.cjs", untracked: false },
  { fails: true, filename: "café.test.cjs", untracked: true },
  { fails: true, filename: "line\nbreak.test.cjs", untracked: false },
])(
  "reports failure=$fails for $filename (untracked=$untracked)",
  async ({ fails, filename, untracked }) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-"));
    try {
      const testPath = `.github/scripts/${filename}`;
      const bin = NodePath.join(root, "bin");
      await NodeFSP.mkdir(bin);
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
      await NodeFSP.writeFile(
        NodePath.join(bin, "git"),
        `#!/usr/bin/env node
if (process.argv[2] === 'merge-base') console.log('0123456789012345678901234567890123456789');
if (process.argv[2] === ${JSON.stringify(untracked ? "ls-files" : "diff")}) {
  const file = ${JSON.stringify(testPath)};
  const quoted = ${JSON.stringify(filename === "example.test.cjs" ? testPath : JSON.stringify(testPath))};
  process.stdout.write(process.argv.includes('-z') ? file + '\\0' : quoted + '\\n');
}
`,
        { mode: 0o755 },
      );
      await NodeFSP.writeFile(
        NodePath.join(bin, "vp"),
        `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'exec' && args[1] === 'node') {
  const result = spawnSync(process.execPath, args.slice(2), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`,
        { mode: 0o755 },
      );

      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(root, "scripts/check-changed.ts"), "HEAD"],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}${NodePath.delimiter}${process.env.PATH}` },
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
