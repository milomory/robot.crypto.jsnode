import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { parsePublicJson } from '../src/market-data/exact-json.js';
import { parseMexcInstrument, parseMexcFunding } from '../src/market-data/mexc.js';
import { parseOkxInstrument, parseOkxFunding } from '../src/market-data/okx.js';
import { compareContractGrids } from '../src/market-data/compatibility.js';
import type { D0Capture } from '../src/market-data/client.js';
import type { InstrumentSpec } from '../src/market-data/model.js';
const bytes = readFileSync(new URL('../fixtures/market-data/d0-public-20261001.json', import.meta.url));
const archive = JSON.parse(bytes.toString()) as {report:D0Capture;compatibility:unknown[]};
const manifest = JSON.parse(readFileSync(new URL('../fixtures/market-data/d0-public-20261001.manifest.json', import.meta.url),'utf8'));
describe('observed public D0a fixture, offline replay', () => {
  it('retains the accepted complete eight-response archive byte hash', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.sha256);
    expect(archive.report).toMatchObject({requestCount:8,status:'complete',failures:[],accountRequests:false,feesVerified:false,executable:false,netEdgeBps:null});
    expect(archive.report.observations).toHaveLength(8);
    expect(new Set(archive.report.observations.map(o=>o.receipt.url)).size).toBe(8);
  });
  it('reproduces all normalized observations from raw lexemes at their original receipt times', () => {
    for(const observation of archive.report.observations){
      const raw=parsePublicJson(Buffer.from(observation.raw)), {base,exchange}=observation.parsed.market;
      const instrument=observation.parsed.kind==='public-linear-contract';
      const parse=exchange==='mexc'?(instrument?parseMexcInstrument:parseMexcFunding):(instrument?parseOkxInstrument:parseOkxFunding);
      expect(parse(raw,base,observation.receipt)).toEqual(observation.parsed);
    }
  });
  it('reproduces different BTC and ETH matched quantity lattices', () => {
    const specs=archive.report.observations.map(o=>o.parsed).filter((o):o is InstrumentSpec=>o.kind==='public-linear-contract');
    const grids=(['BTC','ETH'] as const).map(base=>compareContractGrids(specs.find(s=>s.market.exchange==='mexc'&&s.market.base===base)!,specs.find(s=>s.market.exchange==='okx'&&s.market.base===base)!));
    expect(grids).toEqual(archive.compatibility);
    expect(grids.map(g=>g.minimumMatchedBaseQuantity)).toEqual(['0.0001','0.01']);
  });
  it('rejects replay pretending the recorded funding is current', () => {
    for(const observation of archive.report.observations){
      if(observation.parsed.kind!=='public-funding-estimate')continue;
      const receipt={...observation.receipt,requestedAt:observation.receipt.requestedAt+86400000,receivedAt:observation.receipt.receivedAt+86400000};
      const parse=observation.parsed.market.exchange==='mexc'?parseMexcFunding:parseOkxFunding;
      expect(()=>parse(parsePublicJson(Buffer.from(observation.raw)),observation.parsed.market.base,receipt)).toThrow();
    }
  });
});
