// The observations of one drill, the way run-drill.sh hands them to
// record.ts; record.test.ts and verify-recovery.test.ts start from it.
import { DRILL_ACTIONS, type RecoveryRecord } from "./record.ts";

export const sha = (fill: string) => fill.repeat(64);
export const pointSha256 = sha("a");
export const priorSha256 = sha("b");
export const targetSha256 = sha("c");
const home = "/runner/temp/drill/drill/home";
export const pointId = "20261010T101112123Z-0.0.46-atli.3-to-0.0.46-atli.4";

export const drilledRecord: RecoveryRecord = {
  drillId: "123-1-20261010T101500Z",
  commit: "0447af610f0447af610f0447af610f0447af610f",
  host: "Linux 6.8.0 x86_64 on GitHub Actions 2",
  prior: {
    version: "0.0.46-atli.3",
    archive: "t3-0.0.46-atli.3-linux-x64.tar.gz",
    archiveSha256: priorSha256,
  },
  target: {
    version: "0.0.46-atli.4",
    archive: "t3-0.0.46-atli.4-linux-x64.tar.gz",
    archiveSha256: targetSha256,
  },
  recoveryPoint: {
    id: pointId,
    record: {
      id: pointId,
      createdAt: "2026-10-10T10:11:12.123Z",
      from: {
        version: "0.0.46-atli.3",
        runtimePath: `${home}/runtime/versions/0.0.46-atli.3/t3`,
        archiveSha256: priorSha256,
      },
      to: { version: "0.0.46-atli.4" },
      snapshot: { size: 4096, sha256: pointSha256 },
      actions: [{ at: "2026-10-10T10:11:12.123Z", action: "kept the recovery point" }],
    },
  },
  database: { pointSha256, restoredSha256: pointSha256 },
  preUpgradeEnvironmentId: "environment-before-upgrade",
  home: { path: home, launcher: "/runner/temp/drill/drill/bin/t3" },
  displacedPath: `${home}/recovery/displaced/20261010T101300000Z-${pointId}`,
  readbacks: {
    prior: { stage: "seeded", passed: true, threads: 3, messages: 7 },
    restored: {
      stage: "seeded",
      passed: true,
      threads: 3,
      messages: 7,
      environmentId: "environment-before-upgrade",
    },
  },
  actions: DRILL_ACTIONS.map((name, index) => ({
    name,
    command: `drill ${name}`,
    startedAt: `2026-10-10T10:1${index}:00Z`,
    endedAt: `2026-10-10T10:1${index}:30Z`,
    exitCode: 0,
  })),
};
