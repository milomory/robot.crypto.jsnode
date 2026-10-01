/** Historical book-pair timing qualification, never strategy or execution readiness. */
import { freeze, type InstrumentSpec, type ResearchBase } from './model.js';
import type { PerpetualBook } from './observation-model.js';
export interface BookPairQuality {
  base: ResearchBase; evaluatedAt: number | null; booksPresent: boolean; metadataUsable: boolean;
  receiptSkewMs: number | null; sourceSkewMs: number | null;
  usableForBookComparison: boolean; reasons: readonly string[]; executable: false;
}
export function bookPairQuality(base: ResearchBase, specs: readonly InstrumentSpec[], books: readonly PerpetualBook[]): BookPairQuality {
  const selected = (['mexc','okx'] as const).map(exchange => ({
    spec: specs.find(s=>s.market.base===base&&s.market.exchange===exchange),
    book: books.find(b=>b.market.base===base&&b.market.exchange===exchange),
  }));
  const metadataUsable=selected.every(s=>s.spec?.publicListingUsable===true);
  const booksPresent=selected.every(s=>s.book!==undefined),reasons:string[]=[];
  if(!metadataUsable)reasons.push('metadata-unavailable-or-unusable');
  if(!booksPresent)reasons.push('book-missing');
  const evaluatedAt=booksPresent?Math.max(...selected.map(s=>s.book!.receipt.receivedAt)):null;
  const receiptSkewMs=booksPresent?Math.abs(selected[0].book!.receipt.receivedAt-selected[1].book!.receipt.receivedAt):null;
  const times=selected.map(s=>s.book?.sourceTime.at??null);
  const sourceSkewMs=times.every(t=>t!==null)?Math.abs(times[0]!-times[1]!):null;
  if(receiptSkewMs!==null&&receiptSkewMs>1000)reasons.push('book-receipt-skew');
  if(sourceSkewMs!==null&&sourceSkewMs>1000)reasons.push('book-source-skew');
  if(booksPresent)for(const {book,spec} of selected){
    const b=book!,prefix=b.market.exchange;
    if(!b.sourceTime.representsUpdate)reasons.push(`${prefix}-book-update-time-unverified`);
    if(b.sourceTime.at===null)reasons.push(`${prefix}-book-time-missing`);
    else if(evaluatedAt!-b.sourceTime.at>5000)reasons.push(`${prefix}-book-stale`);
    else if(b.sourceTime.at-evaluatedAt!>5000)reasons.push(`${prefix}-book-time-future`);
    if(spec && (b.metadataReceivedAt!==spec.receipt.receivedAt || b.receipt.requestedAt<spec.receipt.receivedAt || evaluatedAt!-spec.receipt.receivedAt>1_200_000))reasons.push(`${prefix}-metadata-binding-or-age`);
  }
  return freeze({base,evaluatedAt,booksPresent,metadataUsable,receiptSkewMs,sourceSkewMs,
    usableForBookComparison:reasons.length===0,reasons,executable:false});
}
