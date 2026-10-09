// @effect-diagnostics nodeBuiltinImport:off - Reads the committed release workflow as text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// A fork release is dispatched from atli, guarded before any build, admitted
// by upgrading over the prior release's data, and published once: the tag and
// an immutable release with every asset, each asset carrying a build
// provenance attestation.
const workflow = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", ".github", "workflows", "fork-server-release.yml"),
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

const buildJobs = (): ReadonlyArray<string> =>
  [...jobs().keys()].filter((name) => name.startsWith("build-"));

const ATTEST = /uses: actions\/attest-build-provenance@/;

describe("fork server release workflow", () => {
  it("runs only on a dispatch, never on a pushed tag", () => {
    const triggers = topLevelBlock("on")
      .map((line) => /^ {2}([a-z_]+):/.exec(line)?.[1])
      .filter((trigger): trigger is string => trigger !== undefined);
    expect(triggers).toEqual(["workflow_dispatch"]);
    expect(workflow).not.toMatch(/^\s*tags:/m);
  });

  it("reads only contents at the workflow level", () => {
    const permissions = topLevelBlock("permissions").filter((line) => line.trim().length > 0);
    expect(permissions).toEqual(["  contents: read"]);
  });

  it("guards, builds, and publishes in separate jobs", () => {
    const names = [...jobs().keys()];
    expect(names).toEqual(expect.arrayContaining(["guard", "build-linux", "build-mac", "publish"]));
    expect(buildJobs().length).toBeGreaterThan(0);
  });

  it("runs the guard before every build, and checks out the guarded commit", () => {
    expect(needsOf(job("guard"))).toEqual([]);
    expect(job("guard").join("\n")).toMatch(/node scripts\/fork-release-guard\.ts/);
    for (const name of buildJobs()) {
      const body = job(name);
      expect(needsOf(body), name).toContain("guard");
      expect(body.join("\n"), name).toMatch(/ref: \$\{\{ needs\.guard\.outputs\.sha \}\}/);
    }
  });

  it("publishes only after the guard and every build", () => {
    const needs = needsOf(job("publish"));
    expect(needs).toContain("guard");
    for (const name of buildJobs()) expect(needs, name).toContain(name);
  });

  it("publishes nothing unless the Mac desktop app built", () => {
    expect(needsOf(job("publish"))).toEqual(
      expect.arrayContaining(["guard", "build-linux", "admission", "build-mac"]),
    );
  });

  it("builds the Mac arm64 DMG from the guarded commit on a GitHub-hosted macOS runner", () => {
    const body = job("build-mac");
    const text = body.join("\n");
    expect(runsOn(body)).toMatch(/^macos-\d+$/);
    expect(needsOf(body)).toContain("guard");
    expect(text).toMatch(/ref: \$\{\{ needs\.guard\.outputs\.sha \}\}/);

    const rust = stepsOf(body).find((step) => /uses: dtolnay\/rust-toolchain@/.test(step));
    expect(rust).toBeDefined();
    const pinned = /uses: (dtolnay\/rust-toolchain@[0-9a-f]{40})\b/.exec(rust!)?.[1];
    expect(pinned).toBeDefined();
    expect(job("build-linux").join("\n")).toContain(pinned!);
    expect(rust).toMatch(/toolchain: stable/);
    expect(rust).toMatch(/targets: aarch64-apple-darwin/);

    const env = jobMap(body, "env");
    for (const name of [
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      "T3CODE_CLERK_JWT_TEMPLATE",
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      "T3CODE_RELAY_URL",
    ]) {
      expect(env.get(name), name).toBe(`\${{ vars.${name} }}`);
      expect(jobMap(job("build-linux"), "env").get(name), name).toBe(env.get(name));
    }
    expect(env.get("T3CODE_DESKTOP_VERSION")).toBe("${{ needs.guard.outputs.version }}");

    const build = stepsOf(body).findIndex((step) =>
      /run: vp run dist:desktop:dmg:arm64$/m.test(step),
    );
    expect(build).toBeGreaterThan(stepsOf(body).indexOf(rust!));
  });

  it("ships the Mac app unsigned, without Apple secrets", () => {
    const text = job("build-mac").join("\n");
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/--signed|T3CODE_DESKTOP_SIGNED|CSC_|APPLE_/);
  });

  it("checks the Mac app's identity, then attests and uploads the DMG", () => {
    const steps = stepsOf(job("build-mac"));
    const dmg = "release/T3-Code-${{ needs.guard.outputs.version }}-arm64.dmg";
    const build = steps.findIndex((step) => /run: vp run dist:desktop:dmg:arm64$/m.test(step));
    const identity = steps.findIndex((step) => /node scripts\/fork-mac-identity\.ts/.test(step));
    const attest = steps.findIndex((step) => ATTEST.test(step));
    const upload = steps.findIndex((step) => /uses: actions\/upload-artifact@/.test(step));
    expect(build).toBeGreaterThan(-1);
    expect(identity).toBeGreaterThan(build);
    expect(attest).toBeGreaterThan(identity);
    expect(upload).toBeGreaterThan(attest);

    const check = steps[identity]!;
    expect(check).toMatch(
      /hdiutil attach "release\/T3-Code-\$VERSION-arm64\.dmg" -nobrowse -readonly/,
    );
    expect(check).toMatch(/plutil -convert xml1 -o - /);
    expect(check).toMatch(/codesign -dv --verbose=2 [^\n]*2>&1 \|\| true/);
    expect(check).toMatch(/--release-version "\$VERSION"/);
    expect(check).toMatch(/hdiutil detach/);

    expect(steps[attest]).toContain(`subject-path: ${dmg}`);
    expect(steps[upload]).toMatch(/name: release-darwin-arm64\n/);
    expect(steps[upload]).toContain(`path: ${dmg}`);
    expect(steps[upload]).toMatch(/if-no-files-found: error/);
  });

  it("never uploads to an existing release or replaces an asset", () => {
    expect(workflow).not.toMatch(/--clobber/);
    expect(workflow).not.toMatch(/gh\s+release\s+upload/);
    expect(workflow).not.toMatch(/gh\s+release\s+edit/);
    const creates = workflow.match(/gh release create /g) ?? [];
    expect(creates).toHaveLength(1);
    expect(job("publish").join("\n")).toMatch(
      /gh release create "\$TAG" release\/\* \\\n\s+--target "\$SHA"/,
    );
  });

  it("attests every published file under job-level OIDC and attestation permissions", () => {
    for (const name of [...buildJobs(), "publish"]) {
      const body = job(name);
      const permissions = jobMap(body, "permissions");
      expect(permissions.get("id-token"), name).toBe("write");
      expect(permissions.get("attestations"), name).toBe("write");
      expect(body.join("\n"), name).toMatch(ATTEST);
    }
    for (const name of buildJobs()) {
      const steps = stepsOf(job(name));
      const attest = steps.findIndex((step) => ATTEST.test(step));
      const upload = steps.findIndex((step) => /uses: actions\/upload-artifact@/.test(step));
      expect(upload, name).toBeGreaterThan(-1);
      const subject = /subject-path: (.+)/.exec(steps[attest]!)?.[1];
      expect(steps[upload], name).toContain(`path: ${subject}`);
    }
  });

  it("attests SHA256SUMS and manifest.json before creating the release", () => {
    const steps = stepsOf(job("publish"));
    const attest = steps.findIndex(
      (step) =>
        ATTEST.test(step) &&
        step.includes("release/SHA256SUMS") &&
        step.includes("release/manifest.json"),
    );
    const create = steps.findIndex((step) => /gh release create /.test(step));
    expect(attest).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(attest);
    const manifest = steps.findIndex((step) =>
      /node scripts\/fork-release-manifest\.ts/.test(step),
    );
    expect(manifest).toBeGreaterThan(-1);
    expect(manifest).toBeLessThan(attest);
  });

  it("admits the built Linux archive before publish", () => {
    const admission = job("admission");
    expect(needsOf(admission)).toEqual(expect.arrayContaining(["guard", "build-linux"]));
    expect(needsOf(job("publish"))).toContain("admission");
    const text = admission.join("\n");
    expect(text).toMatch(/ref: \$\{\{ needs\.guard\.outputs\.sha \}\}/);
    expect(text).toMatch(
      /uses: actions\/download-artifact@[^\n]*\n\s+with:\n\s+name: release-linux-x64\n/,
    );
    expect(text).toMatch(/bash scripts\/linux-admission\/run-admission\.sh/);
  });

  it("checks the admitted archive against the digest its build reported", () => {
    expect(jobMap(job("build-linux"), "outputs").get("archive-sha256")).toBe(
      "${{ steps.digest.outputs.sha256 }}",
    );
    const digest = stepsOf(job("build-linux")).find((step) => /id: digest/.test(step));
    expect(digest).toMatch(/sha256sum "release-cli\/t3-\$VERSION-linux-x64\.tar\.gz"/);
    expect(job("admission").join("\n")).toMatch(
      /EXPECTED_SHA256: \$\{\{ needs\.build-linux\.outputs\.archive-sha256 \}\}/,
    );
  });

  it("gives the admission job no write permission", () => {
    expect([...jobMap(job("admission"), "permissions")]).toEqual([["contents", "read"]]);
  });

  it("takes the first admission's prior release only from the dispatch input, through env", () => {
    expect(workflow).toMatch(
      /^ {6}admission-bootstrap-prior:\n(?: {8}.*\n)*? {8}required: false\n/m,
    );
    const prior = stepsOf(job("admission")).find((step) =>
      /node scripts\/linux-admission\/prior-release\.ts/.test(step),
    );
    expect(prior).toMatch(/BOOTSTRAP: \$\{\{ inputs\.admission-bootstrap-prior \}\}/);
    expect(prior).toMatch(/--bootstrap "\$BOOTSTRAP"/);
  });

  it("ships ADMISSION.json from the admission artifact, added after the manifest", () => {
    const upload = stepsOf(job("admission")).find((step) =>
      /uses: actions\/upload-artifact@/.test(step),
    );
    expect(upload).toMatch(/name: admission\n/);
    expect(upload).toMatch(/path: .+\/ADMISSION\.json\n/);
    expect(upload).toMatch(/if-no-files-found: error/);

    const steps = stepsOf(job("publish"));
    const manifest = steps.findIndex((step) =>
      /node scripts\/fork-release-manifest\.ts/.test(step),
    );
    const download = steps.findIndex(
      (step) =>
        /uses: actions\/download-artifact@/.test(step) &&
        /name: admission\n/.test(`${step}\n`) &&
        /path: release\b/.test(step),
    );
    expect(download).toBeGreaterThan(manifest);
    expect(manifest).toBeGreaterThan(-1);
  });

  it("attests ADMISSION.json before creating the release with it", () => {
    const steps = stepsOf(job("publish"));
    const download = steps.findIndex((step) => /name: admission\n/.test(`${step}\n`));
    const attest = steps.findIndex(
      (step) => ATTEST.test(step) && step.includes("release/ADMISSION.json"),
    );
    const create = steps.findIndex((step) => /gh release create "\$TAG" release\/\* \\/.test(step));
    expect(download).toBeGreaterThan(-1);
    expect(attest).toBeGreaterThan(download);
    expect(create).toBeGreaterThan(attest);
  });
});
