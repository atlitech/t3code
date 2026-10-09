import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  checkAdmissionRecord,
  isForkServerVersion,
  verifyReleaseAdmission,
} from "./releaseAdmission.ts";

const forkVersion = "0.0.47-atli.1";
const archiveName = `t3-${forkVersion}-linux-x64.tar.gz`;
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);

const admissionJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      version: forkVersion,
      archive: archiveName,
      archiveSha256: digest,
      priorVersion: "0.0.46-atli.3",
      priorSource: "release",
      verifierCommit: "0123456789abcdef",
      checks: [{ name: "upgrade", passed: true, detail: "ok" }],
      ...overrides,
    },
    null,
    2,
  );

// Serves ADMISSION.json (or a 404 when absent) and SHA256SUMS for the release.
const releaseClient = (input: { readonly admission: string | undefined }, requests: string[]) =>
  HttpClient.make((request) => {
    requests.push(request.url);
    if (request.url.endsWith("/ADMISSION.json")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          input.admission === undefined
            ? new Response("Not Found", { status: 404 })
            : new Response(input.admission),
        ),
      );
    }
    if (request.url.endsWith("/SHA256SUMS")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(`${digest}  ${archiveName}\n`)),
      );
    }
    return Effect.die(`unexpected request ${request.url}`);
  });

const verify = (version: string, admission: string | undefined, requests: string[] = []) =>
  verifyReleaseAdmission({
    httpClient: releaseClient({ admission }, requests),
    version,
    platform: "linux",
    arch: "x64",
    releaseBaseUrl: "https://releases.example/download",
  });

describe("isForkServerVersion", () => {
  it("matches only <x.y.z>-atli.<n>", () => {
    assert.isTrue(isForkServerVersion("0.0.46-atli.1"));
    assert.isTrue(isForkServerVersion("1.20.3-atli.12"));
    assert.isFalse(isForkServerVersion("0.0.45"));
    assert.isFalse(isForkServerVersion("0.0.46-nightly.20261009.2861"));
    assert.isFalse(isForkServerVersion("0.0.46-atli.1.2"));
    assert.isFalse(isForkServerVersion("0.0.46-atli"));
  });
});

describe("checkAdmissionRecord", () => {
  const record = { version: forkVersion, archive: archiveName, archiveSha256: digest };
  it("admits the matching archive", () => {
    assert.isUndefined(
      checkAdmissionRecord({ version: forkVersion, archiveName, archiveSha256: digest, record }),
    );
  });
  it("refuses a record for another version, archive, or digest", () => {
    assert.include(
      checkAdmissionRecord({
        version: forkVersion,
        archiveName,
        archiveSha256: digest,
        record: { ...record, version: "0.0.47-atli.2" },
      }),
      "is for 0.0.47-atli.2",
    );
    assert.include(
      checkAdmissionRecord({
        version: forkVersion,
        archiveName: `t3-${forkVersion}-darwin-arm64.tar.gz`,
        archiveSha256: digest,
        record,
      }),
      "admitted only as",
    );
    assert.include(
      checkAdmissionRecord({
        version: forkVersion,
        archiveName,
        archiveSha256: otherDigest,
        record,
      }),
      "is not the archive its admission record admitted",
    );
    assert.include(
      checkAdmissionRecord({ version: forkVersion, archiveName, archiveSha256: undefined, record }),
      "lists no checksum",
    );
  });
});

describe("verifyReleaseAdmission", () => {
  it.effect("fetches nothing for an official version", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      assert.isUndefined(yield* verify("0.0.45", undefined, requests));
      assert.deepEqual(requests, []);
    }),
  );

  it.effect("resolves the admitted digest when the record matches the release archive", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      assert.equal(yield* verify(forkVersion, admissionJson(), requests), digest);
      assert.deepEqual(requests, [
        `https://releases.example/download/v${forkVersion}/ADMISSION.json`,
        `https://releases.example/download/v${forkVersion}/SHA256SUMS`,
      ]);
    }),
  );

  it.effect("refuses a release with no admission record", () =>
    Effect.gen(function* () {
      const error = yield* verify(forkVersion, undefined).pipe(Effect.flip);
      assert.equal(error._tag, "ReleaseAdmissionError");
      assert.include(error.reason, "has no admission record");
    }),
  );

  it.effect.each([
    ["a version mismatch", { version: "0.0.47-atli.2" }, "is for 0.0.47-atli.2"],
    [
      "an archive name mismatch",
      { archive: `t3-${forkVersion}-linux-arm64.tar.gz` },
      "admitted only as",
    ],
    [
      "a digest mismatch",
      { archiveSha256: otherDigest },
      "is not the archive its admission record admitted",
    ],
    ["a malformed record", { archiveSha256: undefined }, "is malformed"],
  ] as const)("refuses %s", ([, overrides, expected]) =>
    Effect.gen(function* () {
      const error = yield* verify(forkVersion, admissionJson(overrides)).pipe(Effect.flip);
      assert.include(error.reason, expected);
    }),
  );
});
