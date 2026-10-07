import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const annotations = {
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  $comment: Schema.optionalKey(Schema.String),
  examples: Schema.optionalKey(Schema.Array(Schema.Json)),
  deprecated: Schema.optionalKey(Schema.Boolean),
  readOnly: Schema.optionalKey(Schema.Boolean),
  writeOnly: Schema.optionalKey(Schema.Boolean),
};
const Form = Schema.Struct({
  ...annotations,
  $schema: Schema.optionalKey(Schema.String),
  type: Schema.Literal("object"),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalProperties: Schema.optionalKey(Schema.Boolean),
});
const Choice = Schema.Struct({
  ...annotations,
  const: Schema.String,
});
const ApprovalField = Schema.Struct({
  ...annotations,
  type: Schema.Literal("string"),
  default: Schema.optionalKey(Schema.Json),
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
  enumNames: Schema.optionalKey(Schema.Array(Schema.String)),
  oneOf: Schema.optionalKey(Schema.Array(Choice)),
});
const PersistenceField = Schema.Struct({
  ...annotations,
  type: Schema.Literal("boolean"),
  default: Schema.optionalKey(Schema.Boolean),
  const: Schema.optionalKey(Schema.Boolean),
  enum: Schema.optionalKey(Schema.Array(Schema.Boolean)),
});
const decodeForm = Schema.decodeUnknownOption(Form, { onExcessProperty: "error" });
const decodeApprovalField = Schema.decodeUnknownOption(ApprovalField, {
  onExcessProperty: "error",
});
const decodePersistenceField = Schema.decodeUnknownOption(PersistenceField, {
  onExcessProperty: "error",
});
const isField = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

// Match complete wire values, never substrings such as "disallow" or "approve_always".
const onceChoice = /^(?:once|(?:allow|accept|approve)(?:[ _-]?once)?)$/i;
const persistenceKey =
  /^(?:always|persist|persistent|remember|always[ _-]?allow|remember[ _-]?(?:choice|decision)|allow[ _-]?always)$/i;

/** Builds only the form content that the existing Approve once card can represent. */
export function resolveClaudeElicitationAcceptance(
  request: ElicitationRequest,
): ElicitationResult | null {
  if ((request.mode !== undefined && request.mode !== "form") || request.url !== undefined) {
    return null;
  }
  if (request.requestedSchema === undefined) return { action: "accept", content: {} };
  const form = Option.getOrUndefined(decodeForm(request.requestedSchema));
  if (!form) return null;

  const entries: Array<[string, string | boolean]> = [];
  for (const [key, field] of Object.entries(form.properties ?? {})) {
    if (!isField(field)) return null;
    const approval = Option.getOrUndefined(decodeApprovalField(field));
    const persistence = Option.getOrUndefined(decodePersistenceField(field));
    let value: string | boolean | undefined;
    if (approval) {
      const choices = approval.oneOf?.map((option) => option.const) ?? approval.enum ?? [];
      value = choices.find(
        (choice) =>
          onceChoice.test(choice) &&
          (approval.enum === undefined || approval.enum.includes(choice)) &&
          // JSON Schema oneOf requires exactly one matching branch.
          (approval.oneOf === undefined ||
            approval.oneOf.filter((option) => option.const === choice).length === 1),
      );
    } else if (
      persistenceKey.test(key) &&
      persistence &&
      persistence.const !== true &&
      (persistence.enum === undefined || persistence.enum.includes(false))
    ) {
      // Only explicit positive persistence switches have a known false opt-out.
      value = false;
    }

    if (value !== undefined) {
      entries.push([key, value]);
    } else if (form.required?.includes(key)) {
      return null;
    }
  }

  const content = Object.fromEntries(entries);
  if (form.required?.some((key) => !Object.hasOwn(content, key))) return null;
  return { action: "accept", content };
}
