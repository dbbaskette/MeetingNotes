/** Renderer + client ownership: an inline search cannot cancel Cmd+K. */
export class SearchOwners {
  private owners = new Map<
    string,
    { id: number; abort: AbortController; done: Promise<void>; finish: () => void }
  >();
  async begin(
    sender: number,
    client: string,
    id: number,
  ): Promise<{ signal: AbortSignal; finish: () => void }> {
    const key = `${sender}:${client}`,
      previous = this.owners.get(key);
    if (previous && id <= previous.id) {
      const stale = new AbortController();
      stale.abort();
      return { signal: stale.signal, finish: () => {} };
    }
    previous?.abort.abort();
    const abort = new AbortController();
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const owner = { id, abort, done, finish: resolve };
    this.owners.set(key, owner);
    if (previous) await previous.done;
    return {
      signal: abort.signal,
      finish: () => {
        resolve();
        if (this.owners.get(key) === owner) this.owners.delete(key);
      },
    };
  }
  cancel(sender: number, client: string, id: number): void {
    const owner = this.owners.get(`${sender}:${client}`);
    if (owner?.id === id) owner.abort.abort();
  }
  destroy(sender: number): void {
    for (const [key, owner] of this.owners) if (key.startsWith(`${sender}:`)) owner.abort.abort();
  }
}
