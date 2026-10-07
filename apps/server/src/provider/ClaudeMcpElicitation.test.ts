import * as NodeAssert from "node:assert/strict";

import type { ElicitationRequest } from "@anthropic-ai/claude-agent-sdk";
import { describe, it } from "vite-plus/test";

import { resolveClaudeElicitationAcceptance } from "./ClaudeMcpElicitation.ts";

const request = {
  serverName: "computer-use",
  message: "Allow access to Safari?",
  mode: "form",
} satisfies ElicitationRequest;

function acceptField(field: unknown, required = true) {
  return resolveClaudeElicitationAcceptance({
    ...request,
    requestedSchema: {
      type: "object",
      properties: { approval: field },
      ...(required ? { required: ["approval"] } : {}),
    },
  });
}

describe("Claude MCP approval-only forms", () => {
  it("accepts empty consent forms with explicit or omitted form mode", () => {
    const { mode: _mode, ...withoutMode } = request;
    for (const base of [request, withoutMode]) {
      NodeAssert.deepStrictEqual(resolveClaudeElicitationAcceptance(base), {
        action: "accept",
        content: {},
      });
      NodeAssert.deepStrictEqual(
        resolveClaudeElicitationAcceptance({ ...base, requestedSchema: { type: "object" } }),
        { action: "accept", content: {} },
      );
    }
  });

  it("accepts enum and titled oneOf approval choices without granting persistence", () => {
    for (const value of [
      "once",
      "allow",
      "accept",
      "approve",
      "allow_once",
      "acceptOnce",
      "Approve once",
    ]) {
      for (const choices of [
        { enum: ["always", value, "decline"] },
        {
          oneOf: [
            { const: "always", title: "Always allow" },
            { const: value, title: "Allow once" },
          ],
        },
      ]) {
        NodeAssert.deepStrictEqual(acceptField({ type: "string", ...choices, default: "always" }), {
          action: "accept",
          content: { approval: value },
        });
      }
    }
  });

  it("requires enum and oneOf constraints to agree and oneOf branches to be unique", () => {
    NodeAssert.deepStrictEqual(
      acceptField({
        type: "string",
        enum: ["approve"],
        oneOf: [{ const: "once" }, { const: "approve" }],
      }),
      { action: "accept", content: { approval: "approve" } },
    );
    NodeAssert.equal(
      acceptField({ type: "string", enum: ["always"], oneOf: [{ const: "once" }] }),
      null,
    );
    NodeAssert.equal(
      acceptField({ type: "string", oneOf: [{ const: "once" }, { const: "once" }] }),
      null,
    );
  });

  it("does not mistake negative, persistent, or arbitrary values for approval", () => {
    for (const value of [
      "disallow",
      "not_approved",
      "approve_always",
      "allow_session",
      "allow_forever",
      "once_then_always",
      "never_allow",
      "yes",
    ]) {
      NodeAssert.equal(acceptField({ type: "string", enum: [value] }), null);
    }
  });

  it("omits optional input and defaults but declines required input it cannot collect", () => {
    NodeAssert.deepStrictEqual(acceptField({ type: "string", format: "email" }, false), {
      action: "accept",
      content: {},
    });
    for (const field of [
      { type: "string", format: "email" },
      { type: "number", default: 42 },
      { type: "boolean", default: true },
    ]) {
      NodeAssert.equal(acceptField(field), null);
    }
    NodeAssert.deepStrictEqual(acceptField({ type: "string", default: "always" }, false), {
      action: "accept",
      content: {},
    });
    NodeAssert.equal(acceptField({ type: "string", default: "once" }), null);
  });

  it("opts out of explicit persistence switches but does not guess arbitrary boolean semantics", () => {
    for (const key of ["always", "persist", "remember", "alwaysAllow", "remember_decision"]) {
      NodeAssert.deepStrictEqual(
        resolveClaudeElicitationAcceptance({
          ...request,
          requestedSchema: {
            type: "object",
            properties: { [key]: { type: "boolean", default: true } },
            required: [key],
          },
        }),
        { action: "accept", content: { [key]: false } },
      );
    }
    for (const key of ["approval", "do_not_remember", "disable_persistence"]) {
      NodeAssert.equal(
        resolveClaudeElicitationAcceptance({
          ...request,
          requestedSchema: {
            type: "object",
            properties: { [key]: { type: "boolean" } },
            required: [key],
          },
        }),
        null,
      );
    }
    for (const constraint of [{ const: true }, { enum: [true] }]) {
      NodeAssert.equal(
        resolveClaudeElicitationAcceptance({
          ...request,
          requestedSchema: {
            type: "object",
            properties: { persist: { type: "boolean", ...constraint } },
            required: ["persist"],
          },
        }),
        null,
      );
    }
  });

  it("preserves valid harmless annotations but rejects unknown validation constraints", () => {
    NodeAssert.deepStrictEqual(
      acceptField({
        type: "string",
        enum: ["once"],
        title: "Approval",
        description: null,
        $comment: "Approval only",
        examples: ["once"],
        deprecated: false,
      }),
      { action: "accept", content: { approval: "once" } },
    );
    for (const constraint of [{ pattern: "^always$" }, { const: "always" }, { maxLength: 2 }]) {
      NodeAssert.equal(acceptField({ type: "string", enum: ["once"], ...constraint }), null);
    }
    NodeAssert.equal(
      resolveClaudeElicitationAcceptance({
        ...request,
        requestedSchema: { type: "object", minProperties: 1 },
      }),
      null,
    );
  });

  it("rejects URL requests, malformed schemas, and absent required properties", () => {
    NodeAssert.equal(
      resolveClaudeElicitationAcceptance({
        ...request,
        mode: "url",
        url: "https://example.com/authorize",
      }),
      null,
    );
    NodeAssert.equal(
      resolveClaudeElicitationAcceptance({
        ...request,
        url: "https://example.com/authorize",
      }),
      null,
    );
    for (const requestedSchema of [
      {},
      { type: "array" },
      { type: "object", properties: null },
      { type: "object", properties: { approval: null } },
      { type: "object", required: ["missing"] },
      { type: "object", required: "approval" },
    ]) {
      NodeAssert.equal(resolveClaudeElicitationAcceptance({ ...request, requestedSchema }), null);
    }
    NodeAssert.equal(acceptField({ type: "string", enum: [true, "once"] }), null);
    NodeAssert.equal(acceptField({ type: "string", oneOf: [{ title: "Allow once" }] }), null);
  });
});
