import { describe, expect, it } from "vite-plus/test";

import { parseUserInputNumber, userInputAnswerError } from "./userInputConstraints.ts";

const question = (constraints: Parameters<typeof userInputAnswerError>[0]["constraints"]) => ({
  header: "Field",
  options: [],
  constraints,
});

describe("userInputAnswerError", () => {
  it("accepts only complete numbers within bounds", () => {
    const age = question({ type: "integer", minimum: 1, maximum: 10 });
    expect(userInputAnswerError(age, " 7 ")).toBeNull();
    for (const answer of ["12abc", "0x10", "7.5", "0", "11"]) {
      expect(userInputAnswerError(age, answer)).toBe("Field: Enter a whole number from 1 to 10.");
    }
    expect(parseUserInputNumber("-1.5e2", false)).toBe(-150);
  });

  it("checks formats, code-point lengths, and selection counts", () => {
    expect(userInputAnswerError(question({ format: "date" }), "2028-02-29")).toBeNull();
    expect(userInputAnswerError(question({ format: "date" }), "2026-02-29")).not.toBeNull();
    expect(
      userInputAnswerError(question({ format: "date-time" }), "2026-10-27T14:30:00+02:00"),
    ).toBeNull();
    expect(
      userInputAnswerError(question({ format: "date-time" }), "2026-10-27T24:30:00Z"),
    ).not.toBeNull();
    expect(userInputAnswerError(question({ format: "uri" }), "mailto:ada@example.com")).toBeNull();
    for (const uri of ["http://example.com/a b", "http://example.com/%zz", "example.com"]) {
      expect(userInputAnswerError(question({ format: "uri" }), uri)).not.toBeNull();
    }
    expect(
      userInputAnswerError(question({ format: "uri", minLength: 20 }), " https://example.com "),
    ).not.toBeNull();
    expect(userInputAnswerError(question({ format: "email" }), "ada")).toBe(
      "Field: Enter an email address.",
    );
    expect(userInputAnswerError(question({ maxLength: 2 }), "👍👍")).toBeNull();
    expect(userInputAnswerError(question({ maxItems: 1 }), ["a", "b"])).toBe(
      "Field: Choose at most 1 option.",
    );
  });

  it("requires explicitly required answers and leaves others optional", () => {
    expect(userInputAnswerError(question({ type: "number" }), "  ")).toBeNull();
    expect(userInputAnswerError(question({ minItems: 1 }), undefined)).toBeNull();
    expect(userInputAnswerError(question(undefined), "anything")).toBeNull();
    expect(userInputAnswerError({ ...question(undefined), required: true }, " ")).toBe(
      "Field: Enter an answer.",
    );
    expect(userInputAnswerError({ ...question(undefined), required: true }, [])).toBe(
      "Field: Enter an answer.",
    );
    expect(
      userInputAnswerError({ ...question(undefined), multiSelect: true, required: true }, []),
    ).toBeNull();
    expect(
      userInputAnswerError({ ...question({ minItems: 1 }), multiSelect: true, required: true }, []),
    ).toBe("Field: Choose at least 1 option.");
  });

  it("rejects answers outside the listed choices and lists for text fields", () => {
    const choice = {
      header: "Plan",
      options: [{ label: "Pro", description: "Pro", value: "pro" }],
      allowCustomAnswer: false,
    };
    expect(userInputAnswerError(choice, "pro")).toBeNull();
    expect(userInputAnswerError(choice, ["Pro"])).toBeNull();
    expect(userInputAnswerError(choice, "enterprise")).toBe(
      "Plan: Choose one of the listed options.",
    );
    expect(userInputAnswerError(choice, ["pro", "Pro"])).toBe("Plan: Choose one option.");
    expect(userInputAnswerError(question({ type: "integer" }), ["3"])).not.toBeNull();
  });
});
