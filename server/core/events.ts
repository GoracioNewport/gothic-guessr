/**
 * Tiny typed event emitter (no `node:events`, so it also runs in a Worker). Listener exceptions are caught and passed
 * to `onError` so a broken subscriber never fails the request that emitted the event.
 */

export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends { [K in keyof Events]: unknown }> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  constructor(private readonly onError: (err: unknown, type: keyof Events) => void = () => {}) {}

  /** Subscribe; returns the unsubscribe function. */
  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set.delete(listener as Listener<never>);
    };
  }

  /** Call every listener of `type` synchronously, in subscription order. */
  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (err) {
        this.onError(err, type);
      }
    }
  }

  /** Number of listeners of `type` (tests, diagnostics). */
  count<K extends keyof Events>(type: K): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}
