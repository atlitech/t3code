import { describe, expect, it } from "vite-plus/test";

import { createBoundedAtomFamily } from "./bounded-atom-family";

const identityFamily = (capacity: number) => {
  let created = 0;
  const family = createBoundedAtomFamily({
    capacity,
    key: (input: string) => input,
    make: (input) => ({ input, id: created++ }),
  });
  return { family, createdCount: () => created };
};

describe("createBoundedAtomFamily", () => {
  it("reuses the value for an equivalent key", () => {
    const { family, createdCount } = identityFamily(4);

    expect(family("a")).toBe(family("a"));
    expect(createdCount()).toBe(1);
  });

  it("evicts the least recently read key once capacity is exceeded", () => {
    const { family, createdCount } = identityFamily(2);
    const a = family("a");
    family("b");

    // Reading "a" promotes it, so "b" is the coldest key when "c" arrives.
    expect(family("a")).toBe(a);
    family("c");

    expect(family("a")).toBe(a);
    expect(createdCount()).toBe(3);

    family("b");
    expect(createdCount()).toBe(4);
  });

  it("keeps at most `capacity` entries alive", () => {
    const { family, createdCount } = identityFamily(2);
    for (const key of ["a", "b", "c", "d"]) {
      family(key);
    }

    // Only "c" and "d" survive, so re-reading them creates nothing new.
    family("c");
    family("d");
    expect(createdCount()).toBe(4);
  });
});
