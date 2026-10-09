/**
 * Per-key async mutex: `run(key, fn)` executes `fn` after every earlier `run` with the same key has settled. The game
 * service serializes all mutations of one game with it, so a double-clicked guess or a guess racing the room's round
 * close cannot interleave between the read and the write (the repository writes are compare-and-set as well).
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Keys with pending work (tests). */
  get size(): number {
    return this.tails.size;
  }
}
