import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;
// RFC 3986: a scheme, then only URI characters and well-formed percent escapes.
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/;

/** Parses a complete decimal number; partial input such as "12abc" or "0x10" is rejected. */
export function parseUserInputNumber(value: string, integer: boolean): number | undefined {
  const trimmed = value.trim();
  const number = DECIMAL.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isFinite(number) && (!integer || Number.isInteger(number)) ? number : undefined;
}

function isValidDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return month >= 1 && month <= 12 && day >= 1 && day <= days;
}

function isValidDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  if (!match) return false;
  const [, date, hour, minute, second, offsetHour, offsetMinute] = match;
  return (
    isValidDate(date!) &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 61 &&
    (offsetHour === undefined || (Number(offsetHour) < 24 && Number(offsetMinute) < 60))
  );
}

function isValidFormat(format: string, value: string): boolean {
  switch (format) {
    case "email":
      return EMAIL.test(value);
    case "uri":
      return URI.test(value);
    case "date":
      return isValidDate(value);
    case "date-time":
      return isValidDateTime(value);
    default:
      return true;
  }
}

const FORMAT_NAMES: Record<string, string> = {
  email: "an email address",
  uri: "a URL",
  date: "a date like 2026-10-27",
  "date-time": "a date and time like 2026-10-27T14:30:00Z",
};

function range(min: number | undefined, max: number | undefined, unit?: string): string {
  const units = (count: number) => (unit === undefined ? "" : ` ${unit}${count === 1 ? "" : "s"}`);
  if (min !== undefined && max !== undefined) return ` from ${min} to ${max}${units(max)}`;
  if (min !== undefined) return ` of at least ${min}${units(min)}`;
  if (max !== undefined) return ` of at most ${max}${units(max)}`;
  return "";
}

/** Describes what a constrained answer must look like, for prompts and validation errors. */
export function describeUserInputConstraints(
  constraints: NonNullable<OrchestrationV2UserInputQuestion["constraints"]>,
): string | undefined {
  const { type, format, minimum, maximum, minLength, maxLength, minItems, maxItems } = constraints;
  if (type !== undefined) {
    return `Enter ${type === "integer" ? "a whole number" : "a number"}${range(minimum, maximum)}.`;
  }
  if (format !== undefined) return `Enter ${FORMAT_NAMES[format]}.`;
  if (minLength !== undefined || maxLength !== undefined) {
    return `Enter text${range(minLength, maxLength, "character")}.`;
  }
  if (minItems !== undefined || maxItems !== undefined) {
    return `Choose${range(minItems, maxItems, "option").replace(/^ of/, "")}.`;
  }
  return undefined;
}

/**
 * Returns why an answer breaks its question's rules, or null when it is acceptable.
 * Formatted answers are judged trimmed, matching how they are sent.
 */
export function userInputAnswerError(
  question: Pick<
    OrchestrationV2UserInputQuestion,
    "header" | "options" | "allowCustomAnswer" | "multiSelect" | "required" | "constraints"
  >,
  answer: string | ReadonlyArray<string> | undefined,
): string | null {
  // An explicit empty selection is present; minItems decides whether it is enough.
  const blank = answer === undefined || (typeof answer === "string" && answer.trim().length === 0);
  if (blank) return question.required === true ? `${question.header}: Enter an answer.` : null;
  const values = typeof answer === "string" ? [answer] : answer;
  if (question.allowCustomAnswer === false && question.options.length > 0) {
    if (question.multiSelect !== true && values.length !== 1) {
      return `${question.header}: Choose one option.`;
    }
    const allowed = new Set(
      question.options.flatMap((option) => [option.label, option.value ?? option.label]),
    );
    if (values.some((value) => !allowed.has(value))) {
      return `${question.header}: Choose one of the listed options.`;
    }
  }
  const constraints = question.constraints;
  if (constraints === undefined) return null;
  const invalid = `${question.header}: ${describeUserInputConstraints(constraints) ?? "Enter a valid answer."}`;
  if (
    (constraints.minItems !== undefined && values.length < constraints.minItems) ||
    (constraints.maxItems !== undefined && values.length > constraints.maxItems)
  ) {
    return invalid;
  }
  const textConstraint =
    constraints.type !== undefined ||
    constraints.format !== undefined ||
    constraints.minLength !== undefined ||
    constraints.maxLength !== undefined;
  if (typeof answer !== "string") return textConstraint ? invalid : null;
  if (constraints.type !== undefined) {
    const number = parseUserInputNumber(answer, constraints.type === "integer");
    return number === undefined ||
      (constraints.minimum !== undefined && number < constraints.minimum) ||
      (constraints.maximum !== undefined && number > constraints.maximum)
      ? invalid
      : null;
  }
  return breaksTextConstraints(
    constraints,
    constraints.format === undefined ? answer : answer.trim(),
  )
    ? invalid
    : null;
}

/** Checks a string exactly as given against format and length rules, blank values included. */
export function breaksTextConstraints(
  constraints: NonNullable<OrchestrationV2UserInputQuestion["constraints"]>,
  value: string,
): boolean {
  // JSON Schema counts string length in code points.
  const length = [...value].length;
  return (
    (constraints.format !== undefined && !isValidFormat(constraints.format, value)) ||
    (constraints.minLength !== undefined && length < constraints.minLength) ||
    (constraints.maxLength !== undefined && length > constraints.maxLength)
  );
}
