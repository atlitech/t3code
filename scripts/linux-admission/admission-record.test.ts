// @effect-diagnostics nodeBuiltinImport:off - Hashes the stand-in archive the test writes.
import * as NodeCrypto from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { REQUIRED_CHECKS, buildAdmissionRecord, writeAdmissionRecord } from "./admission-record.ts";
import { ADMISSION_FILE } from "./prior-release.ts";

const archiveBytes = "stand-in archive bytes";
const archiveSha256 = NodeCrypto.createHash("sha256").update(archiveBytes).digest("hex");
const otherSha256 = NodeCrypto.createHash("sha256").update("another archive").digest("hex");
const verifierCommit = "0447af610f0447af610f0447af610f0447af610f";

const passingChecks = REQUIRED_CHECKS.map((name) => ({ name, passed: true, detail: "ok" }));
const input = {
  version: "0.0.46-atli.4",
  archiveSha256,
  expectedSha256: archiveSha256,
  priorVersion: "0.0.46-atli.3",
  priorSource: "bootstrap" as const,
  verifierCommit,
  checks: passingChecks,
};

const probePassed = [
  { name: "root", passed: true, detail: "GET / answered HTTP 200" },
  {
    name: "environment-version",
    passed: true,
    detail: "serverVersion is '0.0.46-atli.4', release is '0.0.46-atli.4'",
  },
];
const readbackPassed = {
  passed: true,
  threads: 1,
  messages: 1,
  items: [
    { kind: "thread", id: "thread-1", passed: true, detail: "read back" },
    { kind: "message", id: "message-1", passed: true, detail: "read back" },
  ],
};

// Runs the CLI's program in a temp dir and lists what it left in the output directory.
const admit = (options: {
  readonly expectedSha256: string;
  readonly probe: unknown;
  readonly readback: unknown;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "admission-record-" });
    const archive = path.join(dir, "t3-0.0.46-atli.4-linux-x64.tar.gz");
    const out = path.join(dir, "out");
    yield* fs.writeFileString(archive, archiveBytes);
    yield* fs.writeFileString(path.join(dir, "probe.json"), JSON.stringify(options.probe));
    yield* fs.writeFileString(path.join(dir, "readback.json"), JSON.stringify(options.readback));
    const exit = yield* Effect.exit(
      writeAdmissionRecord({
        archive,
        expectedSha256: options.expectedSha256,
        version: "0.0.46-atli.4",
        priorVersion: "0.0.46-atli.3",
        priorSource: "bootstrap",
        verifierCommit,
        probe: path.join(dir, "probe.json"),
        readback: path.join(dir, "readback.json"),
        out,
      }),
    );
    const written = (yield* fs.exists(out)) ? yield* fs.readDirectory(out) : [];
    const record = written.includes(ADMISSION_FILE)
      ? JSON.parse(yield* fs.readFileString(path.join(out, ADMISSION_FILE)))
      : undefined;
    return { exit, written, record };
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("admission record", (it) => {
  it.effect("writes ADMISSION.json with the version, digest, prior, and every check", () =>
    Effect.gen(function* () {
      const result = yield* admit({
        expectedSha256: archiveSha256,
        probe: probePassed,
        readback: readbackPassed,
      });
      assert.strictEqual(result.exit._tag, "Success");
      assert.deepStrictEqual(result.written, [ADMISSION_FILE]);
      assert.strictEqual(result.record.version, "0.0.46-atli.4");
      assert.strictEqual(result.record.archive, "t3-0.0.46-atli.4-linux-x64.tar.gz");
      assert.strictEqual(result.record.archiveSha256, archiveSha256);
      assert.strictEqual(result.record.priorVersion, "0.0.46-atli.3");
      assert.strictEqual(result.record.priorSource, "bootstrap");
      assert.strictEqual(result.record.verifierCommit, verifierCommit);
      assert.deepStrictEqual(
        result.record.checks.map((check: { name: string; passed: boolean }) => [
          check.name,
          check.passed,
        ]),
        REQUIRED_CHECKS.map((name) => [name, true]),
      );
    }),
  );

  it.effect("writes nothing when the archive is not the one the build reported", () =>
    Effect.gen(function* () {
      const result = yield* admit({
        expectedSha256: otherSha256,
        probe: probePassed,
        readback: readbackPassed,
      });
      assert.strictEqual(result.exit._tag, "Failure");
      assert.deepStrictEqual(result.written, []);
    }),
  );

  it.effect("writes nothing when a runtime check failed", () =>
    Effect.gen(function* () {
      const result = yield* admit({
        expectedSha256: archiveSha256,
        probe: [probePassed[0], { ...probePassed[1], passed: false }],
        readback: readbackPassed,
      });
      assert.strictEqual(result.exit._tag, "Failure");
      assert.deepStrictEqual(result.written, []);
    }),
  );

  it.effect("writes nothing when a fixture did not read back", () =>
    Effect.gen(function* () {
      const result = yield* admit({
        expectedSha256: archiveSha256,
        probe: probePassed,
        readback: {
          ...readbackPassed,
          passed: false,
          items: [readbackPassed.items[0], { ...readbackPassed.items[1], passed: false }],
        },
      });
      assert.strictEqual(result.exit._tag, "Failure");
      assert.deepStrictEqual(result.written, []);
    }),
  );
});

it.effect("refuses a record that is incomplete, malformed, or not passed", () =>
  Effect.gen(function* () {
    const refused = [
      { ...input, expectedSha256: otherSha256 },
      { ...input, archiveSha256: "abc", expectedSha256: "abc" },
      { ...input, verifierCommit: "0447af6" },
      { ...input, version: "0.0.46" },
      { ...input, priorVersion: input.version },
      { ...input, checks: [] },
      { ...input, checks: passingChecks.filter((check) => check.name !== "readback") },
      { ...input, checks: [...passingChecks, passingChecks[0]!] },
      {
        ...input,
        checks: passingChecks.map((check) =>
          check.name === "root" ? { ...check, passed: false } : check,
        ),
      },
    ];
    for (const candidate of refused) {
      const error = yield* Effect.flip(buildAdmissionRecord(candidate));
      assert.strictEqual(error._tag, "AdmissionRefusedError", JSON.stringify(candidate));
    }
    const admitted = yield* buildAdmissionRecord(input);
    assert.deepStrictEqual(JSON.parse(admitted.json), admitted.record);
  }),
);
