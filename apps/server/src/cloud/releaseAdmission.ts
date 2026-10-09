import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliReleaseDownloadBaseUrl,
  parseChecksums,
} from "@t3tools/shared/cliRelease";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * Fork releases (`<x.y.z>-atli.<n>`) are installable only once the release
 * carries an ADMISSION.json, written after the version passed an upgrade
 * check against existing data, naming the exact archive it admitted. Official
 * releases carry no record and install as they always have.
 */
const ADMISSION_RECORD_FILE = "ADMISSION.json";
const ADMISSION_FETCH_TIMEOUT = Duration.seconds(30);
const FORK_SERVER_VERSION = /^\d+\.\d+\.\d+-atli\.\d+$/;

/**
 * Fork versions published before admission records existed. Only these can be
 * installed without one, and only by the owner through
 * `t3 update --allow-unadmitted`; the in-app updater never skips admission.
 */
export const PRE_ADMISSION_FORK_VERSIONS: ReadonlyArray<string> = [
  "0.0.46-atli.1",
  "0.0.46-atli.2",
  "0.0.46-atli.3",
];

export const isForkServerVersion = (version: string): boolean => FORK_SERVER_VERSION.test(version);

export class ReleaseAdmissionError extends Schema.TaggedError<ReleaseAdmissionError>()(
  "ReleaseAdmissionError",
  {
    version: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const AdmissionRecord = Schema.Struct({
  version: Schema.String,
  archive: Schema.String,
  archiveSha256: Schema.String,
});
export type AdmissionRecord = typeof AdmissionRecord.Type;
const decodeAdmissionRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(AdmissionRecord));

/**
 * Whether `record` admits `archiveName` with digest `archiveSha256` for
 * `version`. Returns the refusal reason, or undefined when admitted.
 */
export function checkAdmissionRecord(input: {
  readonly version: string;
  readonly archiveName: string;
  readonly archiveSha256: string | undefined;
  readonly record: AdmissionRecord;
}): string | undefined {
  const { version, archiveName, archiveSha256, record } = input;
  if (record.version !== version) {
    return `The admission record on the t3@${version} release is for ${record.version}, not ${version}.`;
  }
  if (record.archive !== archiveName) {
    return `t3@${version} was admitted only as ${record.archive}, not ${archiveName}.`;
  }
  if (archiveSha256 === undefined) {
    return `The t3@${version} release lists no checksum for ${archiveName}.`;
  }
  if (record.archiveSha256.toLowerCase() !== archiveSha256.toLowerCase()) {
    return `The ${archiveName} published for t3@${version} is not the archive its admission record admitted.`;
  }
  return undefined;
}

const fetchText = (httpClient: HttpClient.HttpClient, url: string) =>
  httpClient.execute(HttpClientRequest.get(url)).pipe(
    Effect.flatMap((response) =>
      response.status === 404
        ? Effect.undefined
        : HttpClientResponse.filterStatusOk(response).pipe(Effect.flatMap((ok) => ok.text)),
    ),
    Effect.timeout(ADMISSION_FETCH_TIMEOUT),
  );

/**
 * Checks that the release for `version` admits this machine's archive. For a
 * fork version, resolves the admitted archive's sha256 (the installer must
 * then refuse any downloaded archive with another digest); for an official
 * version, resolves undefined without fetching anything.
 */
export const verifyReleaseAdmission = Effect.fn("cloud.release_admission.verify")(
  function* (input: {
    readonly httpClient: HttpClient.HttpClient;
    readonly version: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly releaseBaseUrl?: string | undefined;
  }) {
    const { version } = input;
    if (!isForkServerVersion(version)) return undefined;
    const refuse = (reason: string) => new ReleaseAdmissionError({ version, reason });
    const platformKey = cliArchivePlatformKey(input.platform, input.arch);
    if (platformKey === undefined) {
      return yield* refuse(`t3@${version} has no archive for ${input.platform}-${input.arch}.`);
    }
    const archiveName = cliArchiveFileName(version, platformKey);
    const baseUrl = cliReleaseDownloadBaseUrl(version, input.releaseBaseUrl);

    const recordText = yield* fetchText(
      input.httpClient,
      `${baseUrl}/${ADMISSION_RECORD_FILE}`,
    ).pipe(Effect.mapError(() => refuse(`Could not read the admission record for t3@${version}.`)));
    if (recordText === undefined) {
      return yield* refuse(
        `t3@${version} has no admission record (${ADMISSION_RECORD_FILE}) on its release, so it was never admitted for install.`,
      );
    }
    const record = yield* decodeAdmissionRecord(recordText).pipe(
      Effect.mapError(() => refuse(`The admission record for t3@${version} is malformed.`)),
    );
    const checksumsText = yield* fetchText(
      input.httpClient,
      `${baseUrl}/${CLI_RELEASE_CHECKSUMS_FILE}`,
    ).pipe(Effect.mapError(() => refuse(`Could not read the t3@${version} release checksums.`)));
    const reason = checkAdmissionRecord({
      version,
      archiveName,
      archiveSha256:
        checksumsText === undefined ? undefined : parseChecksums(checksumsText).get(archiveName),
      record,
    });
    if (reason !== undefined) return yield* refuse(reason);
    return record.archiveSha256.toLowerCase();
  },
);
