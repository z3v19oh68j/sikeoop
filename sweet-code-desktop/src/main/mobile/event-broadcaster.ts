/** A small fan-out bus shared by WeChat and the mobile gateway. */
export class EventBroadcaster<T> {
  #listeners = new Set<(value: T) => void>();
  #onListenerError: (error: unknown) => void;

  constructor(onListenerError: (error: unknown) => void = () => {}) { this.#onListenerError = onListenerError; }

  subscribe(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(value);
      } catch (error) {
        this.#onListenerError(error);
      }
    }
  }

  get size(): number { return this.#listeners.size; }
}
