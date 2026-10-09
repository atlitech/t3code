// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and a gated HTTP fixture.
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// util-linux's script gives the real installer a terminal without a browser or extra packages.
describe.skipIf(HostProcessPlatform.defaultValue() !== "linux")("installer terminal", () => {
  it.each([false, true])(
    "preserves download and install behavior (HTTP failure: %s)",
    async (fail) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-progress-"));
      const version = "1.2.3";
      const stem = `t3-${version}-linux-${HostProcessArchitecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      let resumeDownload: (() => void) | undefined;
      let sawPartialProgress = false;
      let output = "";
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "payload"),
        NodeCrypto.randomBytes(64 * 1024),
      );
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (fail) {
          response.writeHead(500).end();
        } else {
          response.writeHead(200, { "Content-Length": archive.length });
          resumeDownload = () => response.end(archive.subarray(Math.floor(archive.length / 2)));
          response.write(archive.subarray(0, Math.floor(archive.length / 2)));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const installer = NodePath.resolve(import.meta.dirname, "install.sh").replaceAll(
        "'",
        "'\\''",
      );
      const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
        env: {
          ...process.env,
          TERM: "xterm",
          NO_COLOR: "1",
          T3CODE_VERSION: version,
          T3CODE_HOME: NodePath.join(root, "home"),
          T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          resumeDownload?.();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        const versions = NodePath.join(root, "home/runtime/versions");
        if (fail) {
          expect(code).not.toBe(0);
          expect(output).toContain("500");
          expect(output).not.toContain("100%");
          expect(output).not.toContain("Installed T3 Code");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain("Installed T3 Code 1.2.3");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe("1.2.3\n");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
              encoding: "utf8",
            }).trim(),
          ).toBe("t3 v1.2.3");
          expect(await NodeFSP.readdir(versions)).toEqual([version]);
        }
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

const hostPlatform = HostProcessPlatform.defaultValue();

interface Release {
  readonly root: string;
  readonly version: string;
  readonly archiveName: string;
  readonly checksum: string;
}

// A release whose `t3 --version` prints the version, packed the way the
// release workflow names it for this host.
const makeRelease = async (version: string): Promise<Release & { readonly archive: Buffer }> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-admission-"));
  const stem = `t3-${version}-${hostPlatform}-${HostProcessArchitecture.defaultValue()}`;
  const archiveName = `${stem}.tar.gz`;
  await NodeFSP.mkdir(NodePath.join(root, stem));
  await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), `#!/bin/sh\necho 't3 v${version}'\n`, {
    mode: 0o755,
  });
  NodeChildProcess.execFileSync("tar", [
    "-czf",
    NodePath.join(root, archiveName),
    "-C",
    root,
    stem,
  ]);
  const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
  const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  return { root, version, archiveName, checksum, archive };
};

// Pretty-printed like scripts/linux-admission/admission-record.ts writes it.
const admissionRecord = (release: Release, overrides: Record<string, string> = {}) =>
  `${JSON.stringify(
    {
      version: release.version,
      archive: release.archiveName,
      archiveSha256: release.checksum,
      priorVersion: "0.0.46-atli.3",
      priorSource: "release",
      verifierCommit: "0".repeat(40),
      checks: [{ name: "environment-version", passed: true, detail: "version matched" }],
      ...overrides,
    },
    null,
    2,
  )}\n`;

// Runs the installer against a fixture release server; `admission` is the
// ADMISSION.json body, or undefined for a 404.
const install = async (
  release: Release & { readonly archive: Buffer },
  admission: string | undefined,
) => {
  const requested: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    const url = request.url ?? "";
    requested.push(url);
    if (url === `/v${release.version}/SHA256SUMS`) {
      response.end(`${release.checksum}  ${release.archiveName}\n`);
    } else if (url === `/v${release.version}/${release.archiveName}`) {
      response.end(release.archive);
    } else if (url === `/v${release.version}/ADMISSION.json` && admission !== undefined) {
      response.end(admission);
    } else {
      response.writeHead(404).end("Not Found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  try {
    const child = NodeChildProcess.spawn(
      "sh",
      [NodePath.resolve(import.meta.dirname, "install.sh")],
      {
        env: {
          ...process.env,
          NO_COLOR: "1",
          T3CODE_VERSION: release.version,
          T3CODE_HOME: NodePath.join(release.root, "home"),
          T3CODE_INSTALL_BIN_DIR: NodePath.join(release.root, "bin"),
          T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { code, output, requested };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

const installedVersions = (release: Release) =>
  NodeFSP.readdir(NodePath.join(release.root, "home/runtime/versions"));
const binExists = (release: Release) =>
  NodeFSP.lstat(NodePath.join(release.root, "bin/t3")).then(
    () => true,
    () => false,
  );

// Seeds an already downloaded runtime for the release's version whose `t3`
// prints `stale`, optionally recording the archive digest it came from.
const seedCachedRuntime = async (release: Release, archiveSha256: string | undefined) => {
  const target = NodePath.join(release.root, "home/runtime/versions", release.version);
  await NodeFSP.mkdir(target, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(target, "t3"), "#!/bin/sh\necho 'stale'\n", {
    mode: 0o755,
  });
  await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${release.version}\n`);
  if (archiveSha256 !== undefined) {
    await NodeFSP.writeFile(NodePath.join(target, ".archive-sha256"), `${archiveSha256}\n`);
  }
};
const linkedVersion = (release: Release) =>
  NodeChildProcess.execFileSync(NodePath.join(release.root, "bin/t3"), ["--version"], {
    encoding: "utf8",
  }).trim();

describe.skipIf(hostPlatform !== "linux" && hostPlatform !== "darwin")(
  "installer admission",
  () => {
    const fork = "0.0.47-atli.1";

    it.each([
      ["no admission record", undefined, "no admission record"],
      [
        "a record for another archive digest",
        (release: Release) => admissionRecord(release, { archiveSha256: "f".repeat(64) }),
        "does not match the admitted archive digest",
      ],
      [
        "a record for another version",
        (release: Release) => admissionRecord(release, { version: "0.0.47-atli.2" }),
        "admission record is for version '0.0.47-atli.2'",
      ],
      [
        "a record for another archive",
        (release: Release) =>
          admissionRecord(release, { archive: "t3-0.0.47-atli.1-other.tar.gz" }),
        "not t3-0.0.47-atli.1-",
      ],
    ] as const)(
      "refuses a fork version with %s and changes nothing",
      async (_, record, message) => {
        const release = await makeRelease(fork);
        try {
          const result = await install(release, record?.(release));
          expect(result.code).not.toBe(0);
          expect(result.output).toContain(message);
          expect(result.output).toContain("Nothing was changed.");
          expect(result.output).not.toContain("Installed T3 Code");
          expect(await installedVersions(release)).toEqual([]);
          expect(await binExists(release)).toBe(false);
        } finally {
          await NodeFSP.rm(release.root, { recursive: true, force: true });
        }
      },
    );

    it("refuses an already downloaded fork version that is not admitted", async () => {
      const release = await makeRelease(fork);
      try {
        await seedCachedRuntime(release, release.checksum);
        const result = await install(release, undefined);
        expect(result.code).not.toBe(0);
        expect(result.output).toContain("no admission record");
        expect(result.output).toContain("Nothing was changed.");
        expect(await binExists(release)).toBe(false);
        expect(
          await NodeFSP.readFile(
            NodePath.join(release.root, "home/runtime/versions", fork, "t3"),
            "utf8",
          ),
        ).toContain("stale");
      } finally {
        await NodeFSP.rm(release.root, { recursive: true, force: true });
      }
    });

    it("installs a fork version whose record matches the archive", async () => {
      const release = await makeRelease(fork);
      try {
        const result = await install(release, admissionRecord(release));
        expect(result.code).toBe(0);
        expect(result.output).toContain(`Installed T3 Code ${fork}`);
        expect(await installedVersions(release)).toEqual([fork]);
        expect(linkedVersion(release)).toBe(`t3 v${fork}`);
        expect(
          await NodeFSP.readFile(
            NodePath.join(release.root, "home/runtime/versions", fork, ".archive-sha256"),
            "utf8",
          ),
        ).toBe(`${release.checksum}\n`);
      } finally {
        await NodeFSP.rm(release.root, { recursive: true, force: true });
      }
    });

    it("reuses an already downloaded fork runtime bound to the admitted digest", async () => {
      const release = await makeRelease(fork);
      try {
        await seedCachedRuntime(release, release.checksum);
        const result = await install(release, admissionRecord(release));
        expect(result.code).toBe(0);
        expect(result.output).toContain("is already downloaded");
        expect(result.requested).not.toContain(`/v${fork}/${release.archiveName}`);
        expect(linkedVersion(release)).toBe("stale");
      } finally {
        await NodeFSP.rm(release.root, { recursive: true, force: true });
      }
    });

    it.each([
      ["no recorded archive digest", undefined],
      ["a different recorded archive digest", "e".repeat(64)],
    ] as const)(
      "replaces an already downloaded fork runtime with %s by the admitted archive",
      async (_, recorded) => {
        const release = await makeRelease(fork);
        try {
          await seedCachedRuntime(release, recorded);
          const result = await install(release, admissionRecord(release));
          expect(result.code).toBe(0);
          expect(result.output).not.toContain("is already downloaded");
          expect(result.requested).toContain(`/v${fork}/${release.archiveName}`);
          expect(result.output).toContain(`Installed T3 Code ${fork}`);
          expect(await installedVersions(release)).toEqual([fork]);
          expect(linkedVersion(release)).toBe(`t3 v${fork}`);
          expect(
            await NodeFSP.readFile(
              NodePath.join(release.root, "home/runtime/versions", fork, ".archive-sha256"),
              "utf8",
            ),
          ).toBe(`${release.checksum}\n`);
        } finally {
          await NodeFSP.rm(release.root, { recursive: true, force: true });
        }
      },
    );

    it("installs an official version without asking for an admission record", async () => {
      const release = await makeRelease("1.2.3");
      try {
        const result = await install(release, undefined);
        expect(result.code).toBe(0);
        expect(result.output).toContain("Installed T3 Code 1.2.3");
        expect(await installedVersions(release)).toEqual(["1.2.3"]);
        expect(result.requested.some((url) => url.endsWith("/ADMISSION.json"))).toBe(false);
      } finally {
        await NodeFSP.rm(release.root, { recursive: true, force: true });
      }
    });
  },
);
