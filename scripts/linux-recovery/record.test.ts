import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  drilledRecord,
  pointId,
  pointSha256,
  priorSha256,
  sha,
  targetSha256,
} from "./drilled-record.fixture.ts";
import { buildRecoveryRecord, DRILL_ACTIONS, type RecoveryRecord } from "./record.ts";

const installedArchiveSha256 = { prior: priorSha256, target: targetSha256 };

const refusal = (record: RecoveryRecord, installed = installedArchiveSha256) =>
  buildRecoveryRecord({ ...record, installedArchiveSha256: installed }).pipe(
    Effect.flip,
    Effect.map((error) => error.detail),
  );

describe("buildRecoveryRecord", () => {
  it.effect("writes every field a drill observed", () =>
    Effect.gen(function* () {
      const { record, json } = yield* buildRecoveryRecord({
        ...drilledRecord,
        installedArchiveSha256,
      });
      assert.deepStrictEqual(record, drilledRecord);
      const written = JSON.parse(json);
      assert.deepStrictEqual(Object.keys(written), [
        "drillId",
        "commit",
        "host",
        "prior",
        "target",
        "recoveryPoint",
        "database",
        "preUpgradeEnvironmentId",
        "home",
        "displacedPath",
        "readbacks",
        "actions",
      ]);
      assert.deepStrictEqual(written.recoveryPoint.record, drilledRecord.recoveryPoint.record);
      assert.deepStrictEqual(
        written.actions.map((action: { name: string }) => action.name),
        [...DRILL_ACTIONS],
      );
      assert.isTrue(json.endsWith("}\n"));
    }),
  );

  it.effect.each([
    ["no drill id", { ...drilledRecord, drillId: "" }, "drillId is empty"],
    ["no host", { ...drilledRecord, host: " " }, "host is empty"],
    ["a short commit", { ...drilledRecord, commit: "0447af6" }, "full SHA"],
    [
      "no pre-upgrade environment id",
      { ...drilledRecord, preUpgradeEnvironmentId: "" },
      "preUpgradeEnvironmentId is empty",
    ],
    ["no displaced path", { ...drilledRecord, displacedPath: "" }, "displacedPath is empty"],
    [
      "no recovery point id",
      { ...drilledRecord, recoveryPoint: { ...drilledRecord.recoveryPoint, id: "" } },
      "recoveryPoint.id is empty",
    ],
    [
      "no point recovery.json",
      { ...drilledRecord, recoveryPoint: { id: pointId, record: {} } },
      "not a point record",
    ],
    [
      "no prior archive sha256",
      { ...drilledRecord, prior: { ...drilledRecord.prior, archiveSha256: "" } },
      "prior archive sha256 is not a sha256",
    ],
    [
      "no target version",
      { ...drilledRecord, target: { ...drilledRecord.target, version: "" } },
      "target version '' is not a fork version",
    ],
    [
      "an archive of another version",
      {
        ...drilledRecord,
        target: { ...drilledRecord.target, archive: "t3-0.0.46-atli.3-linux-x64.tar.gz" },
      },
      "is not a t3-0.0.46-atli.4 archive",
    ],
    [
      "a prior that is not earlier",
      {
        ...drilledRecord,
        prior: { ...drilledRecord.target },
      },
      "is not earlier than",
    ],
    [
      "no database sha256 at the point",
      { ...drilledRecord, database: { pointSha256: "", restoredSha256: pointSha256 } },
      "database sha256 is not a sha256",
    ],
    [
      "no restored database sha256",
      { ...drilledRecord, database: { pointSha256, restoredSha256: "" } },
      "database sha256 is not a sha256",
    ],
    [
      "a restored database that is not the point's",
      { ...drilledRecord, database: { pointSha256, restoredSha256: sha("d") } },
      "is not the point's",
    ],
    [
      "a displaced path outside the home",
      { ...drilledRecord, displacedPath: "/tmp/elsewhere" },
      "is not in",
    ],
    [
      "a failed restored readback",
      {
        ...drilledRecord,
        readbacks: {
          ...drilledRecord.readbacks,
          restored: { ...drilledRecord.readbacks.restored, passed: false },
        },
      },
      "restored readback did not read the seeded fixtures back",
    ],
    [
      "another environment after the restore",
      {
        ...drilledRecord,
        readbacks: {
          ...drilledRecord.readbacks,
          restored: { ...drilledRecord.readbacks.restored, environmentId: "new" },
        },
      },
      "is not the pre-upgrade",
    ],
    ["no actions", { ...drilledRecord, actions: [] }, "the actions are [], not [install-prior"],
    [
      "an action missing",
      {
        ...drilledRecord,
        actions: drilledRecord.actions.filter((action) => action.name !== "declare-failure"),
      },
      "not [install-prior",
    ],
    [
      "actions out of order",
      {
        ...drilledRecord,
        actions: drilledRecord.actions.toReversed(),
      },
      "not [install-prior",
    ],
    [
      "an action without a command",
      {
        ...drilledRecord,
        actions: drilledRecord.actions.map((action) =>
          action.name === "recover" ? { ...action, command: "" } : action,
        ),
      },
      "recover names no command",
    ],
    [
      "an action without a UTC time",
      {
        ...drilledRecord,
        actions: drilledRecord.actions.map((action) =>
          action.name === "update" ? { ...action, endedAt: "10:12" } : action,
        ),
      },
      "update's times are not ISO-8601 UTC",
    ],
    [
      "an action that failed",
      {
        ...drilledRecord,
        actions: drilledRecord.actions.map((action) =>
          action.name === "recover" ? { ...action, exitCode: 1 } : action,
        ),
      },
      "recover exited 1",
    ],
  ] as const)("refuses a record with %s", ([, record, message]) =>
    Effect.gen(function* () {
      assert.include(yield* refusal(record as RecoveryRecord), message);
    }),
  );

  it.effect("refuses a drill whose installed runtime is not the recorded archive", () =>
    Effect.gen(function* () {
      assert.include(
        yield* refusal(drilledRecord, { prior: priorSha256, target: sha("e") }),
        "installed target runtime came from an archive",
      );
    }),
  );
});
