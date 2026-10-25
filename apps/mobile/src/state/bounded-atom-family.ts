/**
 * Hermes lacks FinalizationRegistry, so Atom.family retains content keys indefinitely.
 * Bound content-keyed atoms by LRU; choose capacity above the mounted working set.
 */
export function createBoundedAtomFamily<Input, Result>(options: {
  readonly capacity: number;
  readonly key: (input: Input) => string;
  readonly make: (input: Input) => Result;
}): (input: Input) => Result {
  const entries = new Map<string, Result>();

  return (input: Input) => {
    const key = options.key(input);
    const existing = entries.get(key);
    if (existing !== undefined) {
      // Map iterates in insertion order, so re-inserting promotes the key to newest.
      entries.delete(key);
      entries.set(key, existing);
      return existing;
    }

    const created = options.make(input);
    entries.set(key, created);
    if (entries.size > options.capacity) {
      const oldest = entries.keys().next();
      if (!oldest.done) {
        entries.delete(oldest.value);
      }
    }
    return created;
  };
}
