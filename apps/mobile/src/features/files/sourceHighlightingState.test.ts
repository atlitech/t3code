import { expect, it, vi } from "vite-plus/test";
import { createSourceHighlightAtomFamily } from "./sourceHighlightingState";

vi.mock("../../lib/highlights", () => ({ highlightCode: vi.fn(() => []) }));

it("stops retaining a file's contents once it falls out of the bounded cache", () => {
  const highlight = vi.fn(() => []);
  const sourceHighlightAtom = createSourceHighlightAtomFamily({ highlight, capacity: 2 });
  const first = { path: "src/a.ts", contents: "const a = 1;", theme: "light" as const };
  const firstAtom = sourceHighlightAtom(first);

  sourceHighlightAtom({ path: "src/b.ts", contents: "const b = 2;", theme: "light" });
  sourceHighlightAtom({ path: "src/c.ts", contents: "const c = 3;", theme: "light" });

  expect(sourceHighlightAtom({ ...first })).not.toBe(firstAtom);
});
