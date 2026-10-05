import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { createBoundedAtomFamily } from "../../state/bounded-atom-family";
import {
  highlightSourceFile,
  type ReviewDiffTheme,
  type ReviewHighlightedToken,
} from "../review/shikiReviewHighlighter";

const SOURCE_HIGHLIGHT_IDLE_TTL_MS = 5 * 60_000;

// Only one file is viewed at a time; this just keeps recently opened files warm
// instead of retaining the full text of every file opened this session.
const SOURCE_HIGHLIGHT_CAPACITY = 16;

export interface SourceHighlightInput {
  readonly path: string;
  readonly contents: string;
  readonly theme: ReviewDiffTheme;
}

export type SourceHighlightTokens = ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;

type SourceHighlighter = (input: SourceHighlightInput) => Promise<SourceHighlightTokens>;

class SourceHighlightError extends Data.TaggedError("SourceHighlightError")<{
  readonly cause: unknown;
}> {}

export function createSourceHighlightAtomFamily(options?: {
  readonly highlight?: SourceHighlighter;
  readonly idleTtlMs?: number;
  readonly capacity?: number;
}) {
  const highlight = options?.highlight ?? highlightSourceFile;
  const idleTtlMs = options?.idleTtlMs ?? SOURCE_HIGHLIGHT_IDLE_TTL_MS;

  return createBoundedAtomFamily({
    capacity: options?.capacity ?? SOURCE_HIGHLIGHT_CAPACITY,
    key: (request: SourceHighlightInput) =>
      `${request.theme}\u0000${request.path}\u0000${request.contents}`,
    make: (request) =>
      Atom.make(
        Effect.tryPromise({
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
