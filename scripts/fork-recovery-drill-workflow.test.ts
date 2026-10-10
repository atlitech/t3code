// @effect-diagnostics nodeBuiltinImport:off - Reads the committed recovery drill workflow as text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// The recovery drill is dispatched from atli with read-only contents. The drill
// job recovers a scratch home and uploads its RECOVERY.json with that home; a
// separate verify job on its own runner re-observes them and uploads
// VERIFICATION.json, the drill's verdict.
const workflow = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", ".github", "workflows", "fork-recovery-drill.yml"),
  "utf8",
);
const lines = workflow.split("\n");

const topLevelBlock = (key: string): ReadonlyArray<string> => {
  const start = lines.indexOf(`${key}:`);
  expect(start, key).toBeGreaterThan(-1);
  const block: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block;
};

const jobs = (): ReadonlyMap<string, ReadonlyArray<string>> => {
  const result = new Map<string, Array<string>>();
  let current: Array<string> | undefined;
  for (const line of topLevelBlock("jobs")) {
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      current = [];
      result.set(job[1]!, current);
      continue;
    }
    current?.push(line);
  }
  return result;
};

const job = (name: string): ReadonlyArray<string> => {
  const body = jobs().get(name);
  expect(body, name).toBeDefined();
  return body!;
};

// The `key:` block directly under a job, as `name: value` pairs.
const jobMap = (body: ReadonlyArray<string>, key: string): ReadonlyMap<string, string> => {
  const start = body.indexOf(`    ${key}:`);
  const entries = new Map<string, string>();
  if (start === -1) return entries;
  for (const line of body.slice(start + 1)) {
    if (/^ {6}#/.test(line)) continue;
    const entry = /^ {6}([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (!entry) break;
    entries.set(entry[1]!, entry[2]!);
  }
  return entries;
};

const needsOf = (body: ReadonlyArray<string>): ReadonlyArray<string> => {
  const inline = body.map((line) => /^ {4}needs:\s*(.+?)\s*$/.exec(line)?.[1]).find(Boolean);
  if (!inline) return [];
  const list = /^\[(.*)\]$/.exec(inline)?.[1] ?? inline;
  return list
    .split(",")
    .map((need) => need.trim())
    .filter((need) => need.length > 0);
};

// Each step as its own text, from its `- ` line to the next.
const stepsOf = (body: ReadonlyArray<string>): ReadonlyArray<string> => {
  const steps: Array<Array<string>> = [];
  for (const line of body) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (steps.length > 0 && /^ {8}/.test(line)) steps.at(-1)!.push(line);
    else if (steps.length > 0 && !/^\s*$/.test(line)) steps.push([]);
  }
  return steps.filter((step) => step.length > 0).map((step) => step.join("\n"));
};

const runsOn = (body: ReadonlyArray<string>): string | undefined =>
  body.map((line) => /^ {4}runs-on:\s*(.+?)\s*$/.exec(line)?.[1]).find(Boolean);

const ifOf = (body: ReadonlyArray<string>): string | undefined =>
  body.map((line) => /^ {4}if:\s*(.+?)\s*$/.exec(line)?.[1]).find(Boolean);

const stepIndex = (steps: ReadonlyArray<string>, pattern: RegExp): number => {
  const index = steps.findIndex((step) => pattern.test(step));
  expect(index, String(pattern)).toBeGreaterThan(-1);
  return index;
};

const ATLI_ONLY = "github.repository == 'atlitech/t3code' && github.ref == 'refs/heads/atli'";
const RUN_DRILL = /run: bash scripts\/linux-recovery\/run-drill\.sh$/m;
const RUN_VERIFY = /run: bash scripts\/linux-recovery\/run-verify\.sh$/m;
const UPLOAD = /uses: actions\/upload-artifact@/;
const DOWNLOAD = /uses: actions\/download-artifact@/;

describe("fork recovery drill workflow", () => {
  it("runs only on a dispatch", () => {
    const triggers = topLevelBlock("on")
      .map((line) => /^ {2}([a-z_]+):/.exec(line)?.[1])
      .filter((trigger): trigger is string => trigger !== undefined);
    expect(triggers).toEqual(["workflow_dispatch"]);
    expect(workflow).not.toMatch(/pull_request_target|workflow_run/);
  });

  it("reads only contents, at the workflow level and in every job", () => {
    const permissions = topLevelBlock("permissions").filter((line) => line.trim().length > 0);
    expect(permissions).toEqual(["  contents: read"]);
    expect([...jobs().keys()]).toEqual(["drill", "verify"]);
    for (const [name, body] of jobs()) {
      expect([...jobMap(body, "permissions")], name).toEqual([["contents", "read"]]);
    }
    expect(workflow).not.toMatch(/:\s*write\b/);
  });

  it("runs both jobs only when dispatched from atli in this repository", () => {
    for (const name of ["drill", "verify"]) expect(ifOf(job(name)), name).toBe(ATLI_ONLY);
  });

  it("never lets a failing step pass", () => {
    expect(workflow).not.toMatch(/continue-on-error/);
    expect(workflow).not.toMatch(/\|\|\s*(true\b|:|exit 0\b)/);
    expect(workflow).not.toMatch(/if:\s*false\b/);
  });

  it("drills the dispatched target, defaulting to the newest admitted release", () => {
    const steps = stepsOf(job("drill"));
    const target = stepIndex(steps, /node scripts\/linux-recovery\/drill-target\.ts/);
    expect(steps[target]).toMatch(/id: target/);
    expect(steps[target]).toMatch(/TARGET_INPUT: \$\{\{ inputs\.target-version \}\}/);
    expect(steps[target]).toMatch(/--target-version "\$TARGET_INPUT"/);
    const drill = stepIndex(steps, RUN_DRILL);
    expect(drill).toBeGreaterThan(target);
    expect(steps[drill]).toMatch(/TARGET_VERSION: \$\{\{ steps\.target\.outputs\.version \}\}/);
    expect(steps[drill]).toMatch(/DRILL_COMMIT: \$\{\{ github\.sha \}\}/);
  });

  it("uploads RECOVERY.json and the drilled home after the drill", () => {
    const steps = stepsOf(job("drill"));
    const drill = stepIndex(steps, RUN_DRILL);
    const upload = stepIndex(steps, UPLOAD);
    expect(upload).toBeGreaterThan(drill);
    expect(steps[upload]).toMatch(/name: recovery-drill$/m);
    expect(steps[upload]).toMatch(/\/RECOVERY\.json$/m);
    expect(steps[upload]).toMatch(/\/drilled-home\.tar\.gz$/m);
    expect(steps[upload]).toMatch(/if-no-files-found: error/);
  });

  it("verifies on a fresh runner after the drill, from the drill's artifact", () => {
    const body = job("verify");
    expect(needsOf(body)).toEqual(["drill"]);
    expect(runsOn(body)).toBe("ubuntu-24.04");
    expect(body.join("\n")).toMatch(/ref: \$\{\{ github\.sha \}\}/);
    const steps = stepsOf(body);
    const download = stepIndex(steps, DOWNLOAD);
    expect(steps[download]).toMatch(/name: recovery-drill$/m);
    const verify = stepIndex(steps, RUN_VERIFY);
    expect(verify).toBeGreaterThan(download);
    expect(steps[verify]).toMatch(/RECORD: [^\n]*\/RECOVERY\.json$/m);
    expect(steps[verify]).toMatch(/DRILLED_HOME_ARCHIVE: [^\n]*\/drilled-home\.tar\.gz$/m);
    expect(job("drill").join("\n")).not.toMatch(RUN_VERIFY);
  });

  it("uploads VERIFICATION.json even when a check fails", () => {
    const steps = stepsOf(job("verify"));
    const verify = stepIndex(steps, RUN_VERIFY);
    const upload = stepIndex(steps, UPLOAD);
    expect(upload).toBeGreaterThan(verify);
    expect(steps[upload]).toMatch(/name: recovery-verification$/m);
    expect(steps[upload]).toMatch(/\/VERIFICATION\.json$/m);
    expect(steps[upload]).toMatch(/if: (always\(\)|\$\{\{ !cancelled\(\) \}\})$/m);
    expect(steps[upload]).toMatch(/if-no-files-found: error/);
  });
});
