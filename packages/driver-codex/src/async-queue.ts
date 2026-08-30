/**
 * Single-consumer async mailbox. The app-server pump and the approval broker both push
 * into it; `send()` drains it. Deliberately tiny — turns are short-lived, events are small.
 */
export class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: ((v: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  /** Ends the iterator once buffered items are drained. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  async *drain(): AsyncGenerator<T, void> {
    for (;;) {
      const buffered = this.#items.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

/** A promise whose settlement is triggered from elsewhere (approval round-trips). */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
