import { describe, expect, it } from "@effect/vitest";
import { mcpElicitationForm } from "./mcpElicitationForm.ts";

const requestedSchema = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name", description: "Your display name" },
    age: { type: "integer", title: "Age", minimum: 18, maximum: 120, default: 30 },
    email: { type: "string", format: "email", title: null },
    subscribe: { type: "boolean", title: "Subscribe" },
    plan: {
      type: "string",
      title: "Plan",
      oneOf: [
        { const: "free", title: "Free" },
        { const: "pro", title: "Pro" },
      ],
    },
    size: { type: "string", enum: ["s", "m"], enumNames: ["Small", "Medium"] },
    tags: {
      type: "array",
      title: "Tags",
      items: {
        anyOf: [
          { const: "a", title: "Alpha" },
          { const: "b", title: "Beta" },
        ],
      },
      maxItems: 1,
    },
  },
  required: ["name", "age", "plan", "tags"],
};

describe("mcpElicitationForm", () => {
  it("maps MCP form fields to user-input questions", () => {
    const form = mcpElicitationForm({
      requester: "Skald",
      message: "Tell us about yourself",
      requestedSchema,
    });
    expect(form?.questions).toEqual([
      {
        id: "name",
        header: "Name",
        question: "Skald asks: Tell us about yourself\n\nYour display name",
        options: [],
        required: true,
      },
      {
        id: "age",
        header: "Age",
        question: "Enter a whole number from 18 to 120.",
        options: [],
        initialAnswer: "30",
        required: true,
        constraints: { type: "integer", minimum: 18, maximum: 120 },
      },
      {
        id: "email",
        header: "email (optional)",
        question: "Enter an email address.",
        options: [],
        required: false,
        constraints: { format: "email" },
      },
      {
        id: "subscribe",
        header: "Subscribe (optional)",
        question: "Subscribe",
        options: [
          { label: "Yes", description: "Yes" },
          { label: "No", description: "No" },
        ],
        allowCustomAnswer: false,
        required: false,
      },
      {
        id: "plan",
        header: "Plan",
        question: "Plan",
        options: [
          { label: "Free", description: "Free" },
          { label: "Pro", description: "Pro" },
        ],
        allowCustomAnswer: false,
        required: true,
      },
      {
        id: "size",
        header: "size (optional)",
        question: "size",
        options: [
          { label: "Small", description: "Small" },
          { label: "Medium", description: "Medium" },
        ],
        allowCustomAnswer: false,
        required: false,
      },
      {
        id: "tags",
        header: "Tags (optional)",
        question: "Choose at most 1 option.",
        options: [
          { label: "Alpha", description: "Alpha" },
          { label: "Beta", description: "Beta" },
        ],
        multiSelect: true,
        allowCustomAnswer: false,
        required: false,
        constraints: { maxItems: 1 },
      },
    ]);
  });

  it("returns typed MCP content and omits unanswered optional fields", () => {
    const form = mcpElicitationForm({ requester: "Skald", message: "", requestedSchema });
    expect(
      form?.content({
        name: " Ada ",
        age: "42",
        email: "",
        subscribe: "No",
        plan: "Pro",
        size: "Medium",
        tags: ["Beta"],
      }),
    ).toEqual({ name: " Ada ", age: 42, subscribe: false, plan: "pro", size: "m", tags: ["b"] });
  });

  it("disambiguates duplicate option labels with their values", () => {
    const form = mcpElicitationForm({
      requester: "Skald",
      message: "Pick one",
      requestedSchema: {
        type: "object",
        properties: { choice: { type: "string", enum: ["x", "y"], enumNames: ["Same", "Same"] } },
      },
    });
    expect(form?.questions[0]?.options.map((option) => option.label)).toEqual([
      "Same (x)",
      "Same (y)",
    ]);
    expect(form?.content({ choice: "Same (y)" })).toEqual({ choice: "y" });
  });

  it("resolves a label before a constant that happens to match it", () => {
    const form = mcpElicitationForm({
      message: "Pick one",
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            oneOf: [
              { const: "b", title: "First" },
              { const: "c", title: "b" },
            ],
          },
        },
      },
    });
    expect(form?.content({ choice: "b" })).toEqual({ choice: "c" });
  });

  it("keeps empty selections, unwraps lone array answers, and leaves choices unconstrained", () => {
    const form = mcpElicitationForm({
      message: "Details",
      requestedSchema: {
        type: "object",
        properties: {
          tags: { type: "array", items: { enum: ["a", "b"] } },
          count: { type: "integer" },
          tier: { type: "string", oneOf: [{ const: "p", title: "Premium" }], maxLength: 1 },
        },
        required: ["tags", "count", "tier"],
      },
    });
    expect(form?.content({ tags: [], count: ["42"], tier: ["Premium"] })).toEqual({
      tags: [],
      count: 42,
      tier: "p",
    });
    expect(form?.questions[2]?.constraints).toBeUndefined();
    // Clients omit a blank optional question; a required list without minItems still sends [].
    expect(form?.questions[0]?.required).toBe(false);
    expect(form?.content({ count: "1", tier: "Premium" })).toEqual({
      tags: [],
      count: 1,
      tier: "p",
    });
  });

  it("offers only constants that satisfy the field's own text rules", () => {
    const schema = (enumValues: Array<string>) => ({
      type: "object",
      properties: { code: { type: "string", enum: enumValues, maxLength: 2 } },
    });
    const form = mcpElicitationForm({
      message: "Code",
      requestedSchema: schema(["ab", "toolong"]),
    });
    expect(form?.questions[0]?.options.map((option) => option.label)).toEqual(["ab"]);
    expect(
      mcpElicitationForm({ message: "Code", requestedSchema: schema(["toolong"]) }),
    ).toBeNull();
  });

  it("turns a form without fields into a confirmation that keeps the message", () => {
    const form = mcpElicitationForm({
      requester: "Skald",
      message: "Publish the review?",
      requestedSchema: { type: "object" },
    });
    expect(form?.questions).toEqual([
      {
        id: "confirm",
        header: "Skald",
        question: "Skald asks: Publish the review?",
        options: [{ label: "Continue", description: "Continue" }],
        allowCustomAnswer: false,
        required: true,
      },
    ]);
    expect(form?.content({ confirm: "Continue" })).toEqual({});
  });

  it("keeps a field named __proto__ as ordinary content", () => {
    const form = mcpElicitationForm({
      message: "Name",
      requestedSchema: JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
      ),
    });
    const content = form?.content(JSON.parse('{"__proto__":"value"}'));
    expect(content && Object.hasOwn(content, "__proto__")).toBe(true);
    expect(content && Object.getPrototypeOf(content)).toBe(Object.prototype);
    expect(JSON.stringify(content)).toBe('{"__proto__":"value"}');
  });

  it("rejects schemas outside the flat MCP form subset", () => {
    for (const schema of [
      undefined,
      { type: "array" },
      { type: "object", properties: { nested: { type: "object" } } },
      { type: "object", properties: { list: { type: "array", items: { type: "string" } } } },
      { type: "object", properties: { " padded": { type: "string" } } },
    ]) {
      expect(
        mcpElicitationForm({ requester: "Skald", message: "Hi", requestedSchema: schema }),
      ).toBeNull();
    }
  });
});
