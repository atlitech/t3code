import * as Schema from "effect/Schema";

export class BridgeIsolationUnavailable extends Schema.TaggedError<BridgeIsolationUnavailable>()(
  "BridgeIsolationUnavailable",
  {
    cause: Schema.optional(Schema.Defect()),
    reason: Schema.Literals([
      "unsupported-platform",
      "unsupported-topology",
      "untrusted-deployment",
      "unsupported-provider",
      "unsupported-connection",
      "unsupported-runtime-settings",
      "unsupported-workspace",
      "workspace-busy",
      "unconfined-execution",
      "runtime-failed",
    ]),
  },
) {
  override get message() {
    return `Bridge isolation is unavailable: ${this.reason}.`;
  }
}
