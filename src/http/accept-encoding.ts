export type SupportedContentEncoding = 'br' | 'gzip';

type EncodingQuality = {
  q: number;
};

const SUPPORTED_ENCODINGS: SupportedContentEncoding[] = ['br', 'gzip'];

function parseQualityParameter(parameters: string[]): number | null {
  let quality = 1;

  for (const parameter of parameters) {
    const [rawName, ...rawValueParts] = parameter.split('=');
    if (rawName.trim().toLowerCase() !== 'q') {
      continue;
    }

    const rawValue = rawValueParts.join('=').trim();
    if (rawValue === '') {
      return null;
    }

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      return null;
    }

    quality = parsed;
  }

  return quality;
}

function parseAcceptEncoding(acceptEncoding: string) {
  const qualities = new Map<string, number>();

  for (const rawEntry of acceptEncoding.split(',')) {
    const [rawToken, ...parameters] = rawEntry.split(';');
    const token = rawToken.trim().toLowerCase();
    if (!token) {
      continue;
    }

    const quality = parseQualityParameter(parameters);
    if (quality === null) {
      continue;
    }

    const currentQuality = qualities.get(token);
    qualities.set(
      token,
      currentQuality === 0 || quality === 0
        ? 0
        : Math.max(currentQuality ?? 0, quality),
    );
  }

  return qualities;
}

function getEncodingQuality(
  encoding: SupportedContentEncoding,
  qualities: Map<string, number>,
): EncodingQuality | null {
  const explicitQuality = qualities.get(encoding);
  if (explicitQuality !== undefined) {
    return { q: explicitQuality };
  }

  const wildcardQuality = qualities.get('*');
  if (wildcardQuality !== undefined) {
    return { q: wildcardQuality };
  }

  return null;
}

export function selectAcceptedContentEncoding(acceptEncoding: string): SupportedContentEncoding | null {
  const qualities = parseAcceptEncoding(acceptEncoding);
  let selected: SupportedContentEncoding | null = null;
  let selectedQuality = 0;

  for (const encoding of SUPPORTED_ENCODINGS) {
    const quality = getEncodingQuality(encoding, qualities);
    if (!quality || quality.q <= 0) {
      continue;
    }

    if (quality.q > selectedQuality) {
      selected = encoding;
      selectedQuality = quality.q;
    }
  }

  return selected;
}
