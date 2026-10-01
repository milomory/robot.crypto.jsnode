import { describe, expect, it } from 'vitest';
import { decimal, multiply, numberText, parsePublicJson, record, timestamp, units } from '../src/market-data/exact-json.js';

const decode = (text: string) => parsePublicJson(Buffer.from(text));

describe('bounded public wire decoding', () => {
  it('keeps values above floating point precision and long fractions opaque and exact', () => {
    const row = record(decode('{"integer":9007199254740993,"fraction":0.12345678901234567890123456789,"exp":1.234567890123456789e-10}'));
    expect(numberText(row.integer)).toBe('9007199254740993');
    expect(numberText(row.fraction)).toBe('0.12345678901234567890123456789');
    expect(decimal(row.exp)).toBe('0.0000000001234567890123456789');
    expect(typeof row.integer).toBe('object'); expect(Object.isFrozen(row.integer)).toBe(true);
  });
  it('handles escaped strings, nesting, booleans and null without converting strings to numeric tokens', () => {
    const value = record(decode('{"text":"a\\\"b","array":[true,false,null,{"number":"123.456"}]}'));
    expect(value.text).toBe('a"b');
    expect(value.array).toEqual([true, false, null, { number: '123.456' }]);
  });
  it('gives every decoded object a null prototype, including suspicious property names', () => {
    const result = record(decode('{"__proto__":{"polluted":true},"constructor":"value"}'));
    expect(Object.getPrototypeOf(result)).toBeNull(); expect(Object.getPrototypeOf(result.__proto__)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it.each([
    '{"a":1,"a":2}', '{"a":1,"\u0061":2}', '{"nested":{"x":1,"x":2}}',
    '{"a":NaN}', '{"a":Infinity}', '{"a":01}', '{"a":1,}', '[1,]', '{"a":+1}',
    'true false', '\ufeff{"ok":true}', '{"bad":"\u0000"}', '{"a":1}\u000c',
  ])('rejects malformed or ambiguous JSON %j', text => { expect(() => decode(text)).toThrow('invalid-public-json'); });
  it('rejects invalid UTF-8 rather than inserting replacement characters', () => {
    expect(() => parsePublicJson(Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]))).toThrow('invalid-public-json');
  });
  it('rejects a body beyond 512 KiB', () => { expect(() => parsePublicJson(Buffer.alloc(512 * 1024 + 1, 32))).toThrow(); });
  it('bounds nested depth and parsed node count', () => {
    expect(() => decode('['.repeat(34) + 'null' + ']'.repeat(34))).toThrow('invalid-public-json');
    expect(() => decode('[' + Array(20001).fill('0').join(',') + ']')).toThrow('invalid-public-json');
  });
  it.each([0, 1.25, NaN, Infinity, true, null, {}, [], { text: '1' }])('never treats a native or forged value as exact numeric wire evidence: %j', value => {
    expect(() => numberText(value)).toThrow('invalid-public-number');
  });
  it.each([null, [], 'text', decode('1')])('requires an object record: %j', value => { expect(() => record(value)).toThrow(); });
});

describe('exact decimal normalization and arithmetic', () => {
  it.each([
    ['1e-30', '0.000000000000000000000000000001'], ['1e29', '100000000000000000000000000000'],
    ['0.001e2', '0.1'], ['123.4000', '123.4'], ['1.2300e3', '1230'], ['0e-60', '0'],
  ])('normalizes %s without Number arithmetic', (input, expected) => { expect(decimal(input)).toBe(expected); });
  it.each(['1e-31', '1e30', '1e61', '1e-61', '0001', '+1', ' 1', '1 ', 'NaN', 'Infinity', '', '.1', '1.',
    '0.0000000000000000000000000000001'])('rejects unsupported decimal %j rather than rounding it', value => {
    expect(() => decimal(value)).toThrow('invalid-public-number');
  });
  it('supports signed funding rates while unsigned contract dimensions reject even negative zero', () => {
    expect(decimal('-0', true)).toBe('0'); expect(decimal('-0.0100', true)).toBe('-0.01');
    expect(() => decimal('-0')).toThrow(); expect(() => decimal('-1')).toThrow();
    expect(() => decimal('0', false, true)).toThrow();
  });
  it('multiplies exactly representable positive contracts and preserves zero', () => {
    expect(multiply('0.01', '0.01')).toBe('0.0001'); expect(multiply('0', '1e-30')).toBe('0');
    expect(multiply('9007199254740993', '0.1')).toBe('900719925474099.3');
  });
  it.each([['1e-30', '0.1'], ['1e29', '10']])('rejects under/overflow in multiplication %j', (a, b) => {
    expect(() => multiply(a, b)).toThrow();
  });
  it.each([['-1', '1'], ['1', '-1'], ['-0', '1']])('rejects signed multiplication of contract quantities %j', (a, b) => {
    expect(() => multiply(a, b)).toThrow('invalid-public-number');
  });
  it('keeps exact positive and negative scalar units', () => {
    expect(units('0.000000000000000000000000000001')).toBe(1n);
    expect(units('-0.000000000000000000000000000001')).toBe(-1n);
    expect(units('9007199254740993')).toBe(9007199254740993n * 10n ** 30n);
  });
  it.each(['0', '-1', '1.5', '1e3', '01', '9007199254740993', '8640000000000001'])('rejects invalid or unsafe timestamp %s', value => {
    expect(() => timestamp(value)).toThrow('invalid-public-time');
  });
  it('accepts millisecond timestamps only within the exact Date range', () => {
    expect(timestamp(decode('1790839943924'))).toBe(1790839943924);
    expect(timestamp('8640000000000000')).toBe(8640000000000000);
    expect(() => timestamp(1790839943924)).toThrow('invalid-public-number');
  });
});
