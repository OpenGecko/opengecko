const DEFAULT_SQD_BASE_URL = 'https://v2.archive.subsquid.io/network/ethereum-mainnet';
const DEFAULT_SWAP_TOPIC0 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const REQUEST_DELAY_MS = 250;
const MAX_RETRIES = 3;

type SqdRequestOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  baseUrl?: string;
  maxRetries?: number;
  requestDelayMs?: number;
  skipHeightLookup?: boolean;
};

type SqdWorkerLog = {
  data?: string;
  topics?: string[];
  transactionHash?: string;
};


type SqdWorkerBlock = {
  header?: {
    number?: number;
    timestamp?: number;
  };
  logs?: SqdWorkerLog[];
};

export type SqdEthereumSwapLog = {
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBaseUrl(explicitBaseUrl?: string) {
  return explicitBaseUrl ?? DEFAULT_SQD_BASE_URL;
}

function parseRetryAfter(value: string | null) {
  if (!value) {
    return null;
  }

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return null;
}

function isRetriableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function requestText(url: string, init: RequestInit, options: SqdRequestOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.maxRetries ?? MAX_RETRIES;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: options.signal,
      });

      if (!response.ok) {
        if (attempt < retries - 1 && isRetriableStatus(response.status)) {
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
          const backoff = retryAfter ?? REQUEST_DELAY_MS * (2 ** attempt);
          await sleep(backoff);
          continue;
        }

        throw new Error(`SQD request failed with status ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      if (attempt >= retries - 1) {
        throw error;
      }

      await sleep(REQUEST_DELAY_MS * (2 ** attempt));
    }
  }

  throw new Error('SQD request exhausted retries');
}

function decodeSignedInt(hex: string) {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  const value = BigInt(`0x${normalized}`);
  const bits = BigInt(normalized.length * 4);
  const max = 1n << bits;
  const midpoint = 1n << (bits - 1n);
  return value >= midpoint ? value - max : value;
}

function decodeUnsignedInt(hex: string) {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt(`0x${normalized || '0'}`);
}

export function decodeUniswapV3SwapLog(data: string): Omit<SqdEthereumSwapLog, 'blockNumber' | 'blockTimestamp' | 'txHash'> | null {
  const normalized = data.startsWith('0x') ? data.slice(2) : data;
  if (normalized.length < 64 * 5) {
    return null;
  }

  const words = Array.from({ length: 5 }, (_, index) => normalized.slice(index * 64, (index + 1) * 64));
  const tickWord = words[4] ?? '';

  return {
    amount0: decodeSignedInt(words[0] ?? '').toString(),
    amount1: decodeSignedInt(words[1] ?? '').toString(),
    sqrtPriceX96: decodeUnsignedInt(words[2] ?? '').toString(),
    liquidity: decodeUnsignedInt(words[3] ?? '').toString(),
    tick: Number(decodeSignedInt(tickWord).toString()),
  };
}

export async function fetchEthereumPoolSwapLogs(
  poolAddress: string,
  options: SqdRequestOptions & {
    fromBlock?: number;
    toBlock?: number;
    topic0?: string;
  } = {},
): Promise<SqdEthereumSwapLog[] | null> {
  const normalizedAddress = poolAddress.trim().toLowerCase();
  const topic0 = (options.topic0 ?? DEFAULT_SWAP_TOPIC0).toLowerCase();
  const baseUrl = getBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const fromBlock = options.fromBlock ?? 12_376_729;

  try {
    const latestHeight = options.skipHeightLookup
      ? options.toBlock ?? fromBlock
      : Number.parseInt(
          await requestText(`${baseUrl}/height`, { method: 'GET' }, { ...options, fetchImpl }),
          10,
        );
    const lastBlock = options.toBlock ?? latestHeight;

    if (!Number.isFinite(latestHeight) || latestHeight < fromBlock) {
      return [];
    }

    const results: SqdEthereumSwapLog[] = [];
    let nextBlock = fromBlock;
    let page = 0;

    while (nextBlock <= lastBlock) {
      if (page > 0) {
        await sleep(options.requestDelayMs ?? REQUEST_DELAY_MS);
      }

      const workerUrl = await requestText(
        `${baseUrl}/${nextBlock}/worker`,
        { method: 'GET' },
        { ...options, fetchImpl },
      );

      const body = JSON.stringify({
        fromBlock: nextBlock,
        toBlock: lastBlock,
        logs: [
          {
            address: [normalizedAddress],
            topic0: [topic0],
          },
        ],
        fields: {
          block: {
            timestamp: true,
          },
          log: {
            data: true,
            topics: true,
            transactionHash: true,
          },
        },
      });

      let workerEndpoint: URL;
      try {
        workerEndpoint = new URL(workerUrl.trim());
      } catch {
        throw new Error(`SQD worker endpoint was not a valid URL: ${workerUrl.trim()}`);
      }

      const responseText = await requestText(
        workerEndpoint.toString(),
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body,
        },
        { ...options, fetchImpl },
      );

      const blocks = JSON.parse(responseText) as SqdWorkerBlock[];
      if (!Array.isArray(blocks) || blocks.length === 0) {
        return results;
      }

      for (const block of blocks) {
        const blockNumber = typeof block.header?.number === 'number' ? block.header.number : null;
        const blockTimestamp = typeof block.header?.timestamp === 'number' ? block.header.timestamp : null;

        for (const log of block.logs ?? []) {
          if (blockNumber === null || blockTimestamp === null || typeof log.data !== 'string') {
            continue;
          }

          const decoded = decodeUniswapV3SwapLog(log.data);
          if (!decoded) {
            continue;
          }

          const txHash = typeof log.transactionHash === 'string'
            ? log.transactionHash
            : '';

          if (!txHash) {
            continue;
          }

          results.push({
            blockNumber,
            blockTimestamp,
            txHash,
            ...decoded,
          });
        }
      }

      const lastProcessedBlock = blocks.at(-1)?.header?.number;
      if (typeof lastProcessedBlock !== 'number' || lastProcessedBlock < nextBlock) {
        break;
      }

      nextBlock = lastProcessedBlock + 1;
      page += 1;
    }

    return results;
  } catch (error) {
    console.error('Failed to fetch SQD Ethereum swap logs', error);
    return null;
  }
}
