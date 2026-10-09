#!/usr/bin/env node

// Fork-only (atlitech/t3code). The runtime check of the Linux admission
// (run-admission.sh): the upgraded candidate serves its client at GET / and
// reports the release's version from GET /.well-known/t3/environment.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export const ENVIRONMENT_PATH = "/.well-known/t3/environment";

export interface AdmissionCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ProbeObservation {
  readonly rootStatus: number | undefined;
  readonly environmentStatus: number | undefined;
  readonly environmentBody: string;
}

const EnvironmentDescriptor = Schema.fromJsonString(
  Schema.Struct({ serverVersion: Schema.String }),
);
const decodeEnvironment = Schema.decodeUnknownOption(EnvironmentDescriptor);

const statusText = (status: number | undefined) =>
  status === undefined ? "no response" : `HTTP ${status}`;

/** The `root` and `environment-version` checks for what the server answered. */
export const evaluateProbe = (
  releaseVersion: string,
  observation: ProbeObservation,
): ReadonlyArray<AdmissionCheck> => {
  const root: AdmissionCheck = {
    name: "root",
    passed: observation.rootStatus === 200,
    detail: `GET / answered ${statusText(observation.rootStatus)}`,
  };
  const descriptor =
    observation.environmentStatus === 200
      ? decodeEnvironment(observation.environmentBody)
      : Option.none();
  const serverVersion = Option.map(descriptor, (value) => value.serverVersion);
  const environment: AdmissionCheck = {
    name: "environment-version",
    passed: Option.contains(serverVersion, releaseVersion),
    detail: Option.match(serverVersion, {
      onNone: () =>
        `GET ${ENVIRONMENT_PATH} answered ${statusText(observation.environmentStatus)} without a serverVersion`,
      onSome: (version) => `serverVersion is '${version}', release is '${releaseVersion}'`,
    }),
  };
  return [root, environment];
};

export class ProbeFailedError extends Schema.TaggedError<ProbeFailedError>()("ProbeFailedError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `The candidate failed its runtime check: ${this.detail}`;
  }
}

/** GETs both paths once; a request that fails to complete reads as no response. */
export const probeServer = Effect.fn("probeServer")(function* (options: {
  readonly baseUrl: string;
  readonly releaseVersion: string;
}) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)),
  );
  const get = (path: string) =>
    client.get(path).pipe(
      Effect.flatMap((response) =>
        response.text.pipe(Effect.map((body) => ({ status: response.status, body }))),
      ),
      Effect.timeout(Duration.seconds(10)),
      Effect.option,
    );
  const [root, environment] = yield* Effect.all([get("/"), get(ENVIRONMENT_PATH)]);
  return evaluateProbe(options.releaseVersion, {
    rootStatus: Option.getOrUndefined(Option.map(root, (response) => response.status)),
    environmentStatus: Option.getOrUndefined(
      Option.map(environment, (response) => response.status),
    ),
    environmentBody: Option.match(environment, {
      onNone: () => "",
      onSome: (response) => response.body,
    }),
  });
});

const encodeChecks = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown, { space: 2 }),
);

export const probe = Effect.fn("probe")(function* (options: {
  readonly baseUrl: string;
  readonly releaseVersion: string;
  readonly out: string;
}) {
  const checks = yield* probeServer(options);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(options.out, `${yield* encodeChecks(checks)}\n`);
  const failed = checks.filter((check) => !check.passed);
  if (failed.length > 0) {
    return yield* new ProbeFailedError({
      detail: failed.map((check) => `${check.name}: ${check.detail}`).join("; "),
    });
  }
  yield* Effect.log(checks.map((check) => `${check.name}: ${check.detail}`).join("\n"));
});

const command = Command.make(
  "linux-admission-probe",
  {
    baseUrl: Flag.String("base-url").pipe(
      Flag.withDescription("The candidate server, for example http://127.0.0.1:47811."),
    ),
    // `--version` is the runner's own flag.
    releaseVersion: Flag.String("release-version").pipe(
      Flag.withDescription("Version the candidate must report, for example 0.0.46-atli.4."),
    ),
    out: Flag.String("out").pipe(Flag.withDescription("Where to write the check results.")),
  },
  (options) => probe(options),
).pipe(Command.withDescription("Check that a candidate serves and reports the release version."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
