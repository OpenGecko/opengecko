export const apiBase = import.meta.env.PUBLIC_OPENGECKO_API_BASE_URL ?? '/__opengecko_api';
export const rawApiBase = import.meta.env.PUBLIC_OPENGECKO_RAW_API_BASE_URL ?? apiBase;

export class OpenGeckoApiError extends Error {
  status: number;
  path: string;

  constructor(path: string, status: number) {
    super(`${path} returned ${status}`);
    this.name = 'OpenGeckoApiError';
    this.path = path;
    this.status = status;
  }
}

export function apiUrl(path: string) {
  return `${apiBase}${path}`;
}

export function rawApiUrl(path: string) {
  return `${rawApiBase}${path}`;
}

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), {
    cache: 'no-store',
    headers: {
      accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new OpenGeckoApiError(path, response.status);
  }

  return response.json() as Promise<T>;
}
