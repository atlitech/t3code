import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { createBoundedAtomFamily } from "../../state/bounded-atom-family";
import { resolveHighlightLanguage } from "../../lib/highlightLanguage";
import { highlightCode, type HighlightedLines, type HighlightScheme } from "../../lib/highlights";

const SOURCE_HIGHLIGHT_IDLE_TTL_MS = 5 * 60_000;

// Only one file is viewed at a time; this just keeps recently opened files warm
// instead of retaining the full text of every file opened this session.
const SOURCE_HIGHLIGHT_CAPACITY = 16;

export interface SourceHighlightInput {
  readonly path: string;
  readonly contents: string;
  readonly theme: HighlightScheme;
}

type SourceHighlighter = (input: SourceHighlightInput) => HighlightedLines;

class SourceHighlightError extends Data.TaggedError("SourceHighlightError")<{
  readonly cause: unknown;
}> {}

export function createSourceHighlightAtomFamily(options?: {
  readonly highlight?: SourceHighlighter;
  readonly idleTtlMs?: number;
  readonly capacity?: number;
}) {
  const highlight =
    options?.highlight ??
    ((input: SourceHighlightInput) =>
      highlightCode(input.contents, resolveHighlightLanguage({ path: input.path }), input.theme));
  const idleTtlMs = options?.idleTtlMs ?? SOURCE_HIGHLIGHT_IDLE_TTL_MS;

  return createBoundedAtomFamily({
    capacity: options?.capacity ?? SOURCE_HIGHLIGHT_CAPACITY,
    key: (request: SourceHighlightInput) =>
      `${request.theme}\u0000${request.path}\u0000${request.contents}`,
    make: (request) =>
      Atom.make(
        Effect.try({
          try: () => highlight(request),
          catch: (cause) => new SourceHighlightError({ cause }),
        }),
      ).pipe(
        Atom.setIdleTTL(idleTtlMs),
        Atom.withLabel(`mobile:source-highlight:${request.theme}:${request.path}`),
      ),
  });
}

export const sourceHighlightAtom = createSourceHighlightAtomFamily();
