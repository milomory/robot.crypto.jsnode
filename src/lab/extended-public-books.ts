import { LabError, type OrderBook, type PublicVenue } from './order-book.js';
import { LAB_SYMBOLS, parseBook, publicBookUrl } from './public-books.js';
import { mexcPublicBookUrl, parseMexcBook } from './mexc-public-book.js';
import { hitbtcBookUrl, hitbtcSymbolUrl, parseHitbtcBook, parseHitbtcSymbol } from './hitbtc-public-book.js';

// Separate from VENUES: legacy observation archives and workers remain three-venue.
export const PUBLIC_VENUES = ['binance', 'bybit', 'okx', 'mexc', 'hitbtc'] as const;
const MAX_BYTES = 256 * 1024;

export class ExtendedPublicBookClient {
  private readonly busy = new Set<PublicVenue>();
  private readonly cooldown = new Map<PublicVenue, number>();
  constructor(private readonly request: typeof fetch = fetch, private readonly clock = Date.now) {}

  private now(): number {
    const time = this.clock();
    if (!Number.isSafeInteger(time) || time <= 0) throw new LabError('invalid-public-clock');
    return time;
  }

  async getBook(venue: PublicVenue, symbol: string): Promise<OrderBook<PublicVenue>> {
    if (!PUBLIC_VENUES.some(v => v === venue) || !LAB_SYMBOLS.some(s => s === symbol)) {
      throw new LabError('unsupported-market');
    }
    if (this.busy.has(venue)) throw new LabError('public-venue-busy');
    if ((this.cooldown.get(venue) ?? 0) > this.now()) throw new LabError('rate-limit-cooldown');
    this.busy.add(venue);
    try {
      if (venue === 'hitbtc') {
        const metadata = await this.read(venue, hitbtcSymbolUrl(symbol));
        const id = parseHitbtcSymbol(symbol, metadata.payload);
        const book = await this.read(venue, hitbtcBookUrl(id));
        return parseHitbtcBook(symbol, book.payload, book.requestedAt, book.receivedAt);
      }
      const book = await this.read(venue, venue === 'mexc' ? mexcPublicBookUrl(symbol) : publicBookUrl(venue, symbol));
      return venue === 'mexc'
        ? parseMexcBook(symbol, book.payload, book.requestedAt, book.receivedAt)
        : parseBook(venue, symbol, book.payload, book.requestedAt, book.receivedAt);
    } finally { this.busy.delete(venue); }
  }

  // Only callers above construct URLs: fixed public GETs, no caller-provided headers or destinations.
  private async read(venue: PublicVenue, url: string) {
    const requestedAt = this.now();
    if ((this.cooldown.get(venue) ?? 0) > requestedAt) throw new LabError('rate-limit-cooldown');
    const controller = new AbortController();
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => { void activeReader?.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancelReader, { once: true });
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new LabError('public-request-timeout')); }, 5_000);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await this.request(url, { method: 'GET', credentials: 'omit', redirect: 'error',
          cache: 'no-store', signal: controller.signal });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new LabError('public-request-timeout');
        }
        if ([418, 429].includes(response.status)) {
          const retry = response.headers.get('retry-after');
          let delay = 60_000;
          if (retry && /^\d+(?:\.\d+)?$/.test(retry)) delay = Math.max(delay, Number(retry) * 1_000);
          else if (retry) {
            const at = Date.parse(retry);
            if (Number.isFinite(at)) delay = Math.max(delay, at - this.now());
          }
          this.cooldown.set(venue, Math.max(this.cooldown.get(venue) ?? 0, this.now() + delay));
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new LabError(`public-http-${response.status}`);
        }
        const length = response.headers.get('content-length');
        if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
          void response.body?.cancel().catch(() => {});
          throw new LabError('public-response-too-large');
        }
        if (!response.body) throw new LabError('invalid-public-response');
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        activeReader = reader;
        let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (controller.signal.aborted) throw new LabError('public-request-timeout');
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BYTES) throw new LabError('public-response-too-large');
            chunks.push(chunk.value);
          }
        } finally { void reader.cancel().catch(() => {}); activeReader = undefined; }
        const payload: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
        return { payload, requestedAt, receivedAt: this.now() };
      })()]);
    } catch (error) {
      if (error instanceof LabError) throw error;
      throw new LabError('public-request-failed');
    } finally {
      clearTimeout(timer!);
      controller.abort();
      controller.signal.removeEventListener('abort', cancelReader);
    }
  }
}
