import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OkxAccountReader } from '../src/accounts/okx.js';
import { AccountError } from '../src/accounts/types.js';
import { collectOkxEarn as collectWithPacing } from '../src/accounts/earn-observation.js';
import { okxEarnSchema, type OkxEarnHistoryRecord, type OkxEarnReader } from '../src/accounts/earn-contract.js';

// Most tests exercise accounting with immediate stub responses; rate-budget
// tests below explicitly advance fake time through the injected delay.
const collectOkxEarn = (reader: OkxEarnReader, options: Parameters<typeof collectWithPacing>[1] = {}) =>
  collectWithPacing(reader, { wait: async () => {}, ...options });

const HOUR = 3_600_000;
const now = Date.UTC(2026, 8, 28, 12, 30);
const credentials = { apiKey: 'fixture-key', apiSecret: 'fixture-secret', passphrase: 'fixture-passphrase' };
const balance = { currency: 'USDT' as const, amount: '105.660000000000000001',
  lendingAmount: '100', pendingAmount: '5.660000000000000001', reportedEarnings: '0.66' };
const rawBalance = () => ({ ccy: 'USDT', amt: balance.amount, loanAmt: balance.lendingAmount,
  pendingAmt: balance.pendingAmount, earnings: balance.reportedEarnings, rate: '99',
  uid: 'private-identity', secret: credentials.apiSecret });
const history = (count: number, earning = '0.001'): OkxEarnHistoryRecord[] => Array.from({ length: count }, (_, index) =>
  ({ currency: 'USDT', amount: index % 2 ? '50' : '100', earnings: earning,
    at: now - 30 * 60_000 - index * HOUR }));
const rawHistory = (count = 1) => history(count).map(row => ({ ccy: row.currency, amt: row.amount,
  earnings: row.earnings, ts: String(row.at), rate: 'private-unknown-rate', uid: 'private-identity' }));
function setup(data: unknown, opts: { clock?: () => number } = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ code: '0', msg: '', data })));
  return { fetch, reader: new OkxAccountReader({ credentials, fetch, clock: opts.clock ?? (() => now) }) };
}
function stub(rows: OkxEarnHistoryRecord[] = []): OkxEarnReader & {
  getEarnBalance: ReturnType<typeof vi.fn<OkxEarnReader['getEarnBalance']>>;
  getEarnHistoryPage: ReturnType<typeof vi.fn<OkxEarnReader['getEarnHistoryPage']>>;
} {
  return { getEarnBalance: vi.fn(async () => balance), getEarnHistoryPage: vi.fn(async after =>
    rows.filter(row => after === undefined || row.at < Number(after)).slice(0, 100)) };
}

describe('OKX Simple Earn Flexible read-only client', () => {
  it('signs the exact fixed balance GET and drops legacy rate and unrelated private fields', async () => {
    const { reader, fetch } = setup([rawBalance()]);
    expect(await reader.getEarnBalance()).toEqual(balance);
    const [url, init] = fetch.mock.calls[0];
    const path = '/api/v5/finance/savings/balance?ccy=USDT';
    expect(String(url)).toBe('https://www.okx.com' + path);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('OK-ACCESS-SIGN')).toBe(createHmac('sha256', credentials.apiSecret)
      .update(new Date(now).toISOString() + 'GET' + path).digest('base64'));
  });

  it('supports explicitly empty Flexible holdings without asserting other Earn wallets are empty', async () => {
    expect(await setup([]).reader.getEarnBalance()).toBeNull();
  });

  it.each(['amt', 'loanAmt', 'pendingAmt', 'earnings'])('requires balance field %s, preserving arbitrary source precision', async field => {
    for (const invalid of [undefined, null, '', 1, '1e-8', '+1', '01', 'private-data', '1'.repeat(31), '0.' + '0'.repeat(31)]) {
      await expect(setup([{ ...rawBalance(), [field]: invalid }]).reader.getEarnBalance()).rejects.toThrow(/^account-invalid-response$/);
    }
  });

  it('rejects ambiguous holdings/currencies and negative principal', async () => {
    for (const rows of [[rawBalance(), rawBalance()], [{ ...rawBalance(), ccy: 'USDC' }],
      [{ ...rawBalance(), amt: '-1' }], [{ ...rawBalance(), loanAmt: '-1' }], [{ ...rawBalance(), pendingAmt: '-1' }]]) {
      await expect(setup(rows).reader.getEarnBalance()).rejects.toThrow(/^account-invalid-response$/);
    }
  });

  it('requests fixed 100-record history and exact timestamp cursor, returning only safe decimal data', async () => {
    const { reader, fetch } = setup(rawHistory());
    expect(await reader.getEarnHistoryPage(String(now))).toEqual(history(1));
    const path = '/api/v5/finance/savings/lending-history?ccy=USDT&limit=100&after=' + now;
    expect(String(fetch.mock.calls[0][0])).toBe('https://www.okx.com' + path);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('OK-ACCESS-SIGN')).toBe(createHmac('sha256', credentials.apiSecret)
      .update(new Date(now).toISOString() + 'GET' + path).digest('base64'));
    expect(JSON.stringify(await setup(rawHistory()).reader.getEarnHistoryPage())).not.toMatch(/private|fixture|rate|uid/);
  });

  it.each(['0', '-1', '1.0', '01', '9007199254740992', '1&ccy=BTC', String(now + 1)])(
    'rejects unsafe cursor before request: %s', async after => {
      const { reader, fetch } = setup([]);
      await expect(reader.getEarnHistoryPage(after)).rejects.toThrow(/^account-invalid-response$/);
      expect(fetch).not.toHaveBeenCalled();
    });

  it('rejects malformed, future, unsorted, oversized and wrong-currency history pages', async () => {
    for (const data of [rawHistory(101), [...rawHistory(2)].reverse(), [{ ...rawHistory()[0], ccy: 'BTC' }],
      [{ ...rawHistory()[0], ts: String(now + 1) }], [{ ...rawHistory()[0], ts: '1e12' }],
      [{ ...rawHistory()[0], amt: '-1' }], [{ ...rawHistory()[0], earnings: 1 }]]) {
      await expect(setup(data).reader.getEarnHistoryPage()).rejects.toThrow(/^account-invalid-response$/);
    }
    await expect(setup(rawHistory()).reader.getEarnHistoryPage(String(now - HOUR))).rejects.toThrow(/^account-invalid-response$/);
  });

  it('retains duplicate timestamps for the collector to detect rather than silently choosing a row', async () => {
    const rows = rawHistory();
    expect(await setup([...rows, { ...rows[0], earnings: '99' }]).reader.getEarnHistoryPage()).toHaveLength(2);
  });

  it('preserves shared redacted rate-limit behavior without retries', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ code: '50011', msg: credentials.apiSecret })));
    const reader = new OkxAccountReader({ credentials, fetch, clock: () => now });
    await expect(reader.getEarnBalance()).rejects.toThrow(/^account-rate-limited$/);
    await expect(reader.getEarnHistoryPage()).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('bounded real Earn accounting', () => {
  it('paginates backward, sums exact 7/30-day accrual and never treats legacy or current principal as actual APR', async () => {
    const reader = stub(history(750, '0.000000000000000001'));
    const result = await collectOkxEarn(reader, { clock: () => now });
    expect(result).toMatchObject({ status: 'available', principalUsdt: balance.amount,
      reportedEarningsUsdt: '0.66', reportedEarningsPeriod: 'unspecified',
      history: { status: 'complete', pagination: 'window-covered', pages: 8, records: 720, gapsDetected: false },
      periods: { days7: { records: 168, coverage: 'complete', recordedEarningsUsdt: '0.000000000000000168', realizedAprPercent: null },
        days30: { records: 720, coverage: 'complete', recordedEarningsUsdt: '0.00000000000000072', realizedAprPercent: null } } });
    expect(reader.getEarnHistoryPage.mock.calls.map(([after]) => after)).toEqual([
      undefined, ...[99, 199, 299, 399, 499, 599, 699].map(index => String(history(750)[index].at))]);
    expect(okxEarnSchema.safeParse(result).success).toBe(true);
  });

  it('does not label shorter retained history as full 7/30-day income or extrapolate to a year', async () => {
    const result = await collectOkxEarn(stub(history(48)), { clock: () => now });
    expect(result).toMatchObject({ status: 'partial', history: { pagination: 'exhausted', records: 48 },
      periods: { days7: { coverage: 'partial', recordedEarningsUsdt: '0.048', realizedAprPercent: null },
        days30: { coverage: 'partial', recordedEarningsUsdt: '0.048', realizedAprPercent: null } } });
  });

  it('does not equate an empty endpoint to proven zero income over the month', async () => {
    const reader = stub(); reader.getEarnBalance.mockResolvedValue(null);
    const result = await collectOkxEarn(reader, { clock: () => now });
    expect(result).toMatchObject({ principalUsdt: '0', reportedEarningsUsdt: null, balanceStatus: 'available', status: 'partial',
      periods: { days7: { coverage: 'partial', recordedEarningsUsdt: '0', firstRecordAt: null, records: 0 } } });
  });

  it('preserves principal when history fails and keeps unknown income null', async () => {
    const reader = stub(); reader.getEarnHistoryPage.mockRejectedValue(new Error('private-network-data'));
    const result = await collectOkxEarn(reader, { clock: () => now });
    expect(result).toMatchObject({ balanceStatus: 'available', principalUsdt: balance.amount, status: 'partial',
      history: { status: 'unavailable', pagination: 'read-error' },
      periods: { days7: { coverage: 'unavailable', recordedEarningsUsdt: null } } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(reader.getEarnHistoryPage).toHaveBeenCalledTimes(1);
  });

  it('persists application rate limits and never attempts history after a rejected balance read', async () => {
    const reader = stub();
    const onRateLimit = vi.fn(async () => {});
    reader.getEarnBalance.mockRejectedValue(new AccountError('account-rate-limited'));
    const result = await collectOkxEarn(reader, { clock: () => now, onRateLimit });
    expect(result.status).toBe('unavailable');
    expect(onRateLimit).toHaveBeenCalledTimes(1);
    expect(reader.getEarnHistoryPage).not.toHaveBeenCalled();
  });

  it('contains cooldown-persistence failures and continues no private reads', async () => {
    const reader = stub();
    reader.getEarnBalance.mockRejectedValue(new AccountError('account-rate-limited'));
    const result = await collectOkxEarn(reader, { clock: () => now,
      onRateLimit: async () => { throw new Error('private-credentials'); } });
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(reader.getEarnHistoryPage).not.toHaveBeenCalled();
  });

  it.each(['account-auth-failed', 'account-api-rejected', 'account-access-denied'])(
    'does not continue after explicit account rejection: %s', async code => {
      const reader = stub(); reader.getEarnBalance.mockRejectedValue(new AccountError(code));
      await collectOkxEarn(reader, { clock: () => now });
      expect(reader.getEarnHistoryPage).not.toHaveBeenCalled();
    });

  it('persists a history rate limit while retaining prior valid earnings', async () => {
    const reader = stub(history(750));
    reader.getEarnHistoryPage.mockImplementationOnce(async () => history(100))
      .mockRejectedValue(new AccountError('account-rate-limited'));
    const onRateLimit = vi.fn(async () => {});
    const result = await collectOkxEarn(reader, { clock: () => now, onRateLimit });
    expect(onRateLimit).toHaveBeenCalledTimes(1);
    expect(result.periods.days7.recordedEarningsUsdt).toBe('0.1');
    expect(result.history.pagination).toBe('read-error');
  });

  it('can retain recorded income while balance is unavailable without using income as current holdings', async () => {
    const reader = stub(history(2)); reader.getEarnBalance.mockRejectedValue(new Error('private'));
    const result = await collectOkxEarn(reader, { clock: () => now });
    expect(result).toMatchObject({ balanceStatus: 'unavailable', principalUsdt: null,
      lendingUsdt: null, pendingUsdt: null, reportedEarningsUsdt: null,
      periods: { days7: { recordedEarningsUsdt: '0.002' } } });
  });

  it('retains partial sums on a later page failure and labels them partial', async () => {
    const reader = stub(history(720)); reader.getEarnHistoryPage.mockImplementationOnce(async () => history(100))
      .mockRejectedValue(new Error('private'));
    const result = await collectOkxEarn(reader, { clock: () => now });
    expect(result).toMatchObject({ history: { status: 'partial', pages: 1, pagination: 'read-error' },
      periods: { days7: { coverage: 'partial', recordedEarningsUsdt: '0.1' } } });
    expect(reader.getEarnHistoryPage).toHaveBeenCalledTimes(2);
  });

  it('retains a complete seven-day window when an older page fails, without claiming the whole month', async () => {
    const reader = stub(history(720));
    reader.getEarnHistoryPage.mockImplementation(async after => {
      if (after && Number(after) === history(200)[199].at) throw new Error('private');
      return history(720).filter(row => after === undefined || row.at < Number(after)).slice(0, 100);
    });
    const result = await collectOkxEarn(reader, { clock: () => now });
    expect(result.periods.days7.coverage).toBe('complete');
    expect(result.periods.days30.coverage).toBe('partial');
  });

  it('detects a missing hourly row and never fills it with synthetic zero income', async () => {
    const rows = history(750); rows.splice(12, 1);
    const result = await collectOkxEarn(stub(rows), { clock: () => now });
    expect(result.history.gapsDetected).toBe(true);
    expect(result.periods.days7).toMatchObject({ records: 167, coverage: 'partial', recordedEarningsUsdt: '0.167' });
  });

  it('detects a stale latest hour even when pagination exhausted successfully', async () => {
    const rows = history(800).slice(2);
    const result = await collectOkxEarn(stub(rows), { clock: () => now });
    expect(result.periods.days7.coverage).toBe('partial');
  });

  it('deduplicates equal decimal records without double counting and flags ambiguous repeated timestamps', async () => {
    const rows = history(3); rows.splice(1, 0, { ...rows[0], earnings: '0.0010', amount: '100.000' });
    const result = await collectOkxEarn(stub(rows), { clock: () => now });
    expect(result).toMatchObject({ history: { records: 3, duplicateRecords: 1, conflictingRecords: 0, status: 'partial' },
      periods: { days7: { recordedEarningsUsdt: '0.003', coverage: 'partial' } } });
  });

  it('does not choose one of conflicting timestamp records or export an arbitrary earnings total', async () => {
    const rows = history(3); rows.splice(1, 0, { ...rows[0], earnings: '99' });
    const result = await collectOkxEarn(stub(rows), { clock: () => now });
    expect(result).toMatchObject({ history: { conflictingRecords: 1, pagination: 'conflict' },
      periods: { days7: { recordedEarningsUsdt: null, coverage: 'unavailable' } } });
    expect(result.principalUsdt).toBe(balance.amount);
  });

  it('stops repeated pagination instead of looping or counting the same hourly records again', async () => {
    const reader = stub(); reader.getEarnHistoryPage.mockResolvedValue(history(100));
    const result = await collectOkxEarn(reader, { clock: () => now });
    expect(result.history).toMatchObject({ pagination: 'stalled', pages: 2, records: 100, duplicateRecords: 100 });
    expect(result.periods.days7.recordedEarningsUsdt).toBe('0.1');
  });

  it('caps unusual dense history at nine pages, preserving an explicit page-limit', async () => {
    const rows = history(1000).map((row, index) => ({ ...row, at: now - 1_000 - index * 1_000 }));
    const reader = stub(rows);
    const result = await collectOkxEarn(reader, { clock: () => now });
    expect(result.history).toMatchObject({ pagination: 'page-limit', pages: 9, records: 900, status: 'partial' });
    expect(reader.getEarnHistoryPage).toHaveBeenCalledTimes(9);
    expect(result.periods.days30.coverage).toBe('partial');
  });

  it('paces immediate balance and nine history requests below six per sliding second', async () => {
    let time = now;
    const starts: number[] = [];
    const waits: number[] = [];
    const rows = history(1000).map((row, index) => ({ ...row, at: now - 1_000 - index * 1_000 }));
    const reader = stub(rows);
    reader.getEarnBalance.mockImplementation(async () => { starts.push(time); return balance; });
    const page = reader.getEarnHistoryPage.getMockImplementation()!;
    reader.getEarnHistoryPage.mockImplementation(async after => { starts.push(time); return page(after); });
    const result = await collectOkxEarn(reader, { clock: () => time,
      wait: async milliseconds => { waits.push(milliseconds); time += milliseconds; } });
    expect(result.history.pages).toBe(9);
    expect(starts).toHaveLength(10);
    expect(waits).toEqual(Array(9).fill(201));
    expect(starts.slice(1).every((start, index) => start - starts[index] >= 201)).toBe(true);
    for (const start of starts) expect(starts.filter(at => at >= start && at < start + 1_000).length).toBeLessThanOrEqual(5);
  });

  it('waits only the remaining interval after response latency and never delays an already spaced request', async () => {
    let time = now;
    const waits: number[] = [];
    const reader = stub(history(120));
    reader.getEarnBalance.mockImplementation(async () => { time += 50; return balance; });
    const page = reader.getEarnHistoryPage.getMockImplementation()!;
    reader.getEarnHistoryPage.mockImplementation(async after => { time += 300; return page(after); });
    await collectOkxEarn(reader, { clock: () => time, wait: async ms => { waits.push(ms); time += ms; } });
    expect(waits).toEqual([151]);
    expect(reader.getEarnHistoryPage).toHaveBeenCalledTimes(2);
  });

  it('does not sleep or start history when pacing would consume the timeout reservation', async () => {
    const reader = stub(history(2));
    const wait = vi.fn(async () => {});
    const result = await collectOkxEarn(reader, { clock: () => now, deadlineAt: now + 5_200, wait });
    expect(result.balanceStatus).toBe('available');
    expect(result.history).toMatchObject({ pagination: 'deadline', pages: 0 });
    expect(reader.getEarnHistoryPage).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it('rechecks deadline after an overslept pacing interval before making any history request', async () => {
    let time = now;
    const reader = stub(history(2));
    const result = await collectOkxEarn(reader, { clock: () => time, deadlineAt: now + 5_500,
      wait: async milliseconds => { time += milliseconds + 500; } });
    expect(result.history).toMatchObject({ pagination: 'deadline', pages: 0 });
    expect(reader.getEarnHistoryPage).not.toHaveBeenCalled();
    expect(result.principalUsdt).toBe(balance.amount);
  });

  it('stops on a clock rewind during pacing without starting another private read', async () => {
    let time = now;
    const reader = stub(history(2));
    const result = await collectOkxEarn(reader, { clock: () => time, wait: async () => { time--; } });
    expect(result.history).toMatchObject({ pagination: 'read-error', pages: 0 });
    expect(reader.getEarnHistoryPage).not.toHaveBeenCalled();
  });

  it('uses a real timer by default, verified under fake timers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const starts: number[] = [];
      const reader = stub(history(2));
      reader.getEarnBalance.mockImplementation(async () => { starts.push(Date.now()); return balance; });
      const page = reader.getEarnHistoryPage.getMockImplementation()!;
      reader.getEarnHistoryPage.mockImplementation(async after => { starts.push(Date.now()); return page(after); });
      const pending = collectWithPacing(reader);
      await vi.advanceTimersByTimeAsync(200);
      expect(reader.getEarnHistoryPage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(starts).toEqual([now, now + 201]);
    } finally { vi.useRealTimers(); }
  });

  it('honors the caller deadline and reserves a full transport timeout before starting another GET', async () => {
    let time = now;
    const reader = stub(history(750));
    reader.getEarnBalance.mockImplementation(async () => { time += 3_000; return balance; });
    const fetchPage = reader.getEarnHistoryPage.getMockImplementation()!;
    reader.getEarnHistoryPage.mockImplementation(async after => { time += 4_000; return fetchPage(after); });
    const result = await collectOkxEarn(reader, { clock: () => time, deadlineAt: now + 13_000 });
    expect(result.history).toMatchObject({ pagination: 'deadline', pages: 2, status: 'partial' });
    expect(reader.getEarnHistoryPage).toHaveBeenCalledTimes(2);
  });

  it('makes no requests when deadline has less than one transport timeout left', async () => {
    const reader = stub();
    const result = await collectOkxEarn(reader, { clock: () => now, deadlineAt: now + 4_999 });
    expect(result.status).toBe('unavailable');
    expect(result.periods.days7.recordedEarningsUsdt).toBeNull();
    expect(reader.getEarnBalance).not.toHaveBeenCalled();
    expect(reader.getEarnHistoryPage).not.toHaveBeenCalled();
  });

  it('excludes the exact start boundary and records after the observation cutoff', async () => {
    const rows = [{ ...history(1)[0], at: now + 1 }, { ...history(1)[0], at: now },
      { ...history(1)[0], at: now - 7 * 24 * HOUR }, { ...history(1)[0], at: now - 30 * 24 * HOUR }];
    const result = await collectOkxEarn(stub(rows), { clock: () => now });
    expect(result.periods.days7).toMatchObject({ records: 1, recordedEarningsUsdt: '0.001' });
    expect(result.periods.days30).toMatchObject({ records: 2, recordedEarningsUsdt: '0.002' });
  });

  it('preserves signed corrections and thirty decimal places with no floating-point loss', async () => {
    const rows = history(3);
    rows[0].earnings = '999999999999999999999999999999.000000000000000000000000000001';
    rows[1].earnings = '-999999999999999999999999999999'; rows[2].earnings = '0.1';
    const result = await collectOkxEarn(stub(rows), { clock: () => now });
    expect(result.periods.days7.recordedEarningsUsdt).toBe('0.100000000000000000000000000001');
  });

  it('rejects inconsistent period timestamp pairs, null earnings and unsupported complete labels', async () => {
    const result = await collectOkxEarn(stub(history(2)), { clock: () => now });
    for (const patch of [
      { firstRecordAt: null }, { lastRecordAt: null }, { firstRecordAt: null, lastRecordAt: null },
      { recordedEarningsUsdt: null }, { coverage: 'unavailable' }, { records: 0 },
      { firstRecordAt: result.periods.days7.from }, { lastRecordAt: now + 1 },
      { firstRecordAt: result.periods.days7.lastRecordAt }, { coverage: 'complete' },
    ]) {
      expect(okxEarnSchema.safeParse({ ...result, periods: { ...result.periods,
        days7: { ...result.periods.days7, ...patch } } }).success).toBe(false);
    }
    const empty = await collectOkxEarn(stub(), { clock: () => now });
    for (const patch of [{ firstRecordAt: now }, { lastRecordAt: now }, { recordedEarningsUsdt: '1' }]) {
      expect(okxEarnSchema.safeParse({ ...empty, periods: { ...empty.periods,
        days7: { ...empty.periods.days7, ...patch } } }).success).toBe(false);
    }
  });

  it('cross-checks period and history bounds, counters, pagination and availability', async () => {
    const result = await collectOkxEarn(stub(history(2)), { clock: () => now });
    for (const patch of [
      { firstRecordAt: null }, { lastRecordAt: null }, { records: 1 }, { pages: 0 },
      { firstRecordAt: result.history.firstRecordAt! - HOUR },
      { lastRecordAt: result.history.lastRecordAt! + 1 },
      { duplicateRecords: 99 }, { conflictingRecords: 1 }, { pagination: 'conflict' },
      { pagination: 'stalled' }, { pagination: 'page-limit' }, { status: 'unavailable' },
    ]) expect(okxEarnSchema.safeParse({ ...result, history: { ...result.history, ...patch } }).success).toBe(false);
    expect(okxEarnSchema.safeParse({ ...result, reportedEarningsUsdt: null }).success).toBe(false);
    expect(okxEarnSchema.safeParse({ ...result, periods: { ...result.periods,
      days30: { ...result.periods.days30, recordedEarningsUsdt: '99' } } }).success).toBe(false);
  });

  it('permits unavailable unspecified-period earnings only for an explicitly empty current holding', async () => {
    const reader = stub(history(2)); reader.getEarnBalance.mockResolvedValue(null);
    const result = await collectOkxEarn(reader, { clock: () => now });
    expect(okxEarnSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ principalUsdt: '0', lendingUsdt: '0', pendingUsdt: '0', reportedEarningsUsdt: null,
      periods: { days7: { recordedEarningsUsdt: '0.002' } } });
  });

  it('strictly rejects extra private fields and attempts to manufacture an APR or complete coverage', async () => {
    const result = await collectOkxEarn(stub(history(2)), { clock: () => now });
    expect(okxEarnSchema.safeParse({ ...result, private: 'secret' }).success).toBe(false);
    expect(okxEarnSchema.safeParse({ ...result, status: 'available' }).success).toBe(false);
    expect(okxEarnSchema.safeParse({ ...result, periods: { ...result.periods,
      days7: { ...result.periods.days7, realizedAprPercent: '5.0' } } }).success).toBe(false);
  });
});
