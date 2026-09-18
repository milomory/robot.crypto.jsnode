import { describe, expect, it } from 'vitest';
import { apiUrl } from '../ui/src/api-url';

describe('API base path', () => {
  it.each([
    [undefined, '/api/status'], ['', '/api/status'], ['/api', '/api/status'],
    ['/crypto-api', '/crypto-api/status'], ['/crypto-api/', '/crypto-api/status']
  ])('maps the API prefix for base %s', (base, expected) => {
    expect(apiUrl('/api/status', base)).toBe(expected);
  });
});
