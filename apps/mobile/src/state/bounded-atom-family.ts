/**
 * Memoize atoms by a derived string key, keeping at most `capacity` of them.
 *
 * `Atom.family` is the usual tool for this, but it only evicts through
 * `FinalizationRegistry`, which Hermes does not implement. On React Native it
 * therefore falls back to a map that holds every key it has ever seen. That is fine
 * for families keyed by an id and wrong for families keyed by content: the key
 * strings alone accumulate megabytes of source text that will never be rendered
 * again, and the atom shells pin their closures alongside them.
 *
 * Reading a key refreshes its recency; the least recently read key is dropped once
 * capacity is exceeded. Evicting a key that is still mounted is safe but wasteful —
 * the consumer gets a fresh atom and recomputes — so keep the capacity comfortably
 * above the number of keys that can be mounted at the same time.
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
