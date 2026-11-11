/** Background summary work yields to actual note input, including between
 * provider responses. Saving the note does not use this gate. */
export class WritingIdleGate {
  private quietUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiting = new Set<(ready: boolean) => void>();
  private disposed = false;

  constructor(private readonly quietMs = 3_000) {}

  activity(): void {
    if (this.disposed) return;
    this.quietUntil = performance.now() + this.quietMs;
    if (this.waiting.size) this.schedule();
  }

  wait(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (performance.now() >= this.quietUntil) return Promise.resolve(true);
    return new Promise(resolve => {
      this.waiting.add(resolve);
      this.schedule();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.finish(false);
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (performance.now() < this.quietUntil) this.schedule();
      else this.finish(true);
    }, Math.max(0, this.quietUntil - performance.now()));
  }

  private finish(ready: boolean): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const resolve of this.waiting) resolve(ready);
    this.waiting.clear();
  }
}
