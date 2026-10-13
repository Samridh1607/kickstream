/**
 * Gathers items that arrive close together and hands them on as one list.
 *
 * With `waitMs` of 0 each item is handed on at once, by itself.
 */
export function batched<T>(deliver: (items: T[]) => void, waitMs: number) {
  let waiting: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const items = waiting;
    waiting = [];
    if (items.length > 0) deliver(items);
  };
  return {
    add(item: T): void {
      if (waitMs <= 0) {
        deliver([item]);
        return;
      }
      waiting.push(item);
      timer ??= setTimeout(flush, waitMs);
    },
    /** Drops what is waiting. Used when the stream it came from is closed. */
    cancel(): void {
      clearTimeout(timer);
      timer = undefined;
      waiting = [];
    },
  };
}
