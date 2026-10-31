/** FIFO read/write gate shared by direct and Script calls. Composite tools hold no lease. */
export class ToolScheduler {
  private queue: Array<{ read: boolean; start(): void }> = [];
  private readers = 0;
  private writer = false;
  constructor(private readonly maxReaders: number) {}

  run<T>(read: boolean, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ read, start: () => {
        if (read) this.readers++; else this.writer = true;
        void Promise.resolve().then(() => { signal.throwIfAborted(); return work(); })
          .then(resolve, reject).finally(() => {
            if (read) this.readers--; else this.writer = false;
            this.pump();
          });
      } });
      this.pump();
    });
  }

  private pump() {
    if (this.writer) return;
    while (this.queue.length) {
      const next = this.queue[0]!;
      if (next.read ? this.readers >= this.maxReaders : this.readers > 0) return;
      this.queue.shift(); next.start();
      if (!next.read) return;
    }
  }
}
