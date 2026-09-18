// VITE_API_BASE replaces the /api prefix (for example, /crypto-api).
export const apiUrl = (path: string, base = '/api'): string =>
  `${(base || '/api').replace(/\/$/, '')}${path.replace(/^\/api(?=\/|$)/, '')}`;
