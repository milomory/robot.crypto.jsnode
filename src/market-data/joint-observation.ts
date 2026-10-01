/** One-base public book evidence. Acquisition success is distinct from temporal comparability. */
import { parsePublicJson } from './exact-json.js';
import { freeze, publicUrl, reject, type InstrumentSpec, type PublicReceipt, type ResearchBase } from './model.js';
import { observationUrl, type PerpetualBook } from './observation-model.js';
import { parseOkxInstrument } from './okx.js';
import { parseOkxBook } from './okx-observations.js';
import { parseSpotInstrument, parseSpotBook, spotUrl, type SpotInstrument, type SpotBook } from './spot-observations.js';
import { qualifyJointBooks, type JointBookQuality } from './joint-quality.js';
import type { MexcBookCapture } from './mexc-book-session.js';
export const JOINT_ROUTES = ['okx-perpetual-instrument','okx-spot-instrument','mexc-spot-instrument','mexc-spot-book','okx-perpetual-book','okx-spot-book'] as const;
export type JointRoute = typeof JOINT_ROUTES[number];
export type JointValue = InstrumentSpec | PerpetualBook | SpotInstrument | SpotBook;
export interface JointRead {
  route: JointRoute; requestedAt: number; endedAt: number;
  observation: {raw: string; receipt: PublicReceipt; parsed: JointValue} | null;
  failure: string | null;
  /** A planned read rejected before fetch was called; omitted for actual requests. */
  notDispatched?: true;
}
export interface JointCapture {
  schema: 1; kind: 'joint-public-books'; base: ResearchBase; startedAt: number; endedAt: number;
  status: 'complete' | 'incomplete'; failure: string | null; requestCount: number;
  reads: readonly JointRead[]; mexc: MexcBookCapture | null; quality: JointBookQuality;
  accountRequests: false; executable: false; netEdgeBps: null;
}
export const JOINT_LIMITS = Object.freeze({maximumRequests:9, maximumRestReads:6, maximumConnections:1,
  maximumConcurrency:2, maximumResponseBytes:512*1024, maximumRawBytes:7*1024*1024,
  captureTimeoutMs:50_000, metadataTimeoutMs:5000, bookTimeoutMs:3000, maximumArchiveBytes:132*1024*1024});
export const JOINT_FAILURES = Object.freeze(['joint-http-timeout','joint-http-access-denied','joint-http-rate-limited',
  'joint-http-failed','joint-http-unavailable','joint-response-too-large','joint-schema-rejected','joint-peer-failed',
  'joint-capture-deadline','invalid-public-clock','joint-mexc-incomplete']);
export function jointUrl(base: ResearchBase, route: JointRoute): string {
  if (!JOINT_ROUTES.includes(route)) return reject('unsupported-joint-route');
  if (route === 'okx-perpetual-instrument') return publicUrl('okx',base,'instrument');
  if (route === 'okx-perpetual-book') return observationUrl('okx',base,'book');
  return spotUrl(route.startsWith('okx')?'okx':'mexc',base,route.endsWith('instrument')?'instrument':'book');
}
export function normalizeJointRead(base: ResearchBase, route: JointRoute, raw: string, receipt: PublicReceipt, reads: readonly JointRead[]): JointValue {
  if(receipt.url !== jointUrl(base,route)) return reject('joint-route-mismatch');
  const json=parsePublicJson(Buffer.from(raw));
  if(route==='okx-perpetual-instrument')return parseOkxInstrument(json,base,receipt);
  if(route.endsWith('instrument'))return parseSpotInstrument(json,route.startsWith('okx')?'okx':'mexc',base,receipt);
  const metadataRoute=route.replace(/book$/,'instrument') as JointRoute;
  const spec=reads.find(r=>r.route===metadataRoute)?.observation?.parsed;
  if(!spec)return reject('joint-missing-spec');
  if(route==='okx-perpetual-book')return parseOkxBook(json,base,receipt,spec as InstrumentSpec);
  return parseSpotBook(json,route.startsWith('okx')?'okx':'mexc',base,receipt,spec as SpotInstrument);
}
export function jointQuality(base: ResearchBase, at: number, reads: readonly JointRead[], mexc: MexcBookCapture | null): JointBookQuality {
  const values=reads.flatMap(r=>r.observation?[r.observation.parsed]:[]);
  const specs=values.filter(v=>v.market.type==='spot'?('quantityStep' in v):v.kind==='public-linear-contract') as (InstrumentSpec|SpotInstrument)[];
  const books=values.filter(v=>'bids' in v) as (PerpetualBook|SpotBook)[];
  return qualifyJointBooks(base,at,[...specs,...(mexc?.metadata?[mexc.metadata.parsed]:[])],[...books,...(mexc?.book?[mexc.book]:[])]);
}
export function jointResult(base: ResearchBase, startedAt:number, endedAt:number, reads:readonly JointRead[], mexc:MexcBookCapture|null, failure:string|null):JointCapture {
  return freeze({schema:1,kind:'joint-public-books',base,startedAt,endedAt,status:failure?'incomplete':'complete',failure,
    requestCount:reads.filter(r=>!r.notDispatched).length+(mexc?.requestCount??0),reads,mexc,quality:jointQuality(base,endedAt,reads,mexc),
    accountRequests:false,executable:false,netEdgeBps:null});
}
