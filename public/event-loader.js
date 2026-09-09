const covers = (cached, required) => cached?.generation === required.generation && cached.from <= required.from && cached.until >= required.until;

export class EventLoader {
  constructor(fetchPage) { this.fetchPage = fetchPage; this.sequence = 0; this.loaded = null; this.pending = null; this.controller = null; }
  cancel() { this.sequence++; this.controller?.abort(); this.controller = null; this.pending = null; }
  clear() { this.cancel(); this.loaded = null; }
  needs(required) {
    if (covers(this.loaded, required)) {
      if (this.pending && !covers(this.pending, required)) this.cancel();
      return false;
    }
    return !covers(this.pending, required);
  }
  async load(period) {
    this.cancel();
    const sequence = this.sequence, controller = this.controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    this.pending = period;
    try {
      let data;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const query = new URLSearchParams({ from: period.from, until: period.until, limit: '1000' });
          data = await this.fetchPage(query, { signal });
          if (sequence !== this.sequence) return null;
          query.set('revision', data.revision);
          for (let page = 2; page <= data.pages; page++) {
            query.set('page', page);
            const next = await this.fetchPage(query, { signal });
            if (sequence !== this.sequence) return null;
            data.events.push(...next.events);
          }
          break;
        } catch (error) { if (sequence !== this.sequence) return null; if (error.status !== 409 || attempt === 1) throw error; }
      }
      const changed = this.loaded?.from !== period.from || this.loaded?.until !== period.until || this.loaded?.generation !== period.generation;
      this.loaded = period;
      return { data, changed };
    } finally { if (sequence === this.sequence) { this.pending = null; this.controller = null; } }
  }
}
