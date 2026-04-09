import { createLogger, serializeErrorForLog } from '../lib/logger';

const DEFAULT_SQD_BASE_URL = 'https://v2.archive.subsquid.io/network/ethereum-mainnet';
const DEFAULT_SWAP_TOPIC0 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const REQUEST_DELAY_MS = 250;
const MAX_RETRIES = 3;
const DEFAULT_RECENT_WINDOW_BLOCKS = 40_000;
const DEFAULT_MAX_BLOCK_SPAN = 4_000;
const MIN_BLOCK_SPAN = 128;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const EXPECTED_TEST_FAILURE_LOG_LEVEL = process.env.VITEST === 'true' ? 'warn' : 'error';

const KNOWN_LABELS: Record<string, string> = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap Universal Router',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router 2',
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640': 'Uniswap V3: USDC-WETH',
  '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7': 'Curve: FRAX-USDC',
};
const logger = createLogger({ level: process.env.LOG_LEVEL === 'silent' ? 'silent' : 'info' });

function logSqdFailure(message: string, error: unknown) {
  logger[EXPECTED_TEST_FAILURE_LOG_LEVEL]({ error: serializeErrorForLog(error) }, message);
}

export function resolveAddressLabel(address: string): string | null {
  return KNOWN_LABELS[address.toLowerCase()] ?? null;
}

type SqdRequestOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  baseUrl?: string;
  maxRetries?: number;
  requestDelayMs?: number;
  skipHeightLookup?: boolean;
  recentWindowBlocks?: number;
  maxBlockSpan?: number;
  minBlockSpan?: number;
};

const SQD_BROWSER_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
  origin: 'https://docs.sqd.ai',
  referer: 'https://docs.sqd.ai/',
  'user-agent': 'Mozilla/5.0 (compatible; OpenGecko/0.2; +https://github.com/zed-wong/OpenGecko)',
} as const;

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

type SqdFetchPageResult = {
  swaps: SqdEthereumSwapLog[];
  reachedBlock: number | null;
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

function getRequestDelay(options: SqdRequestOptions) {
  return options.requestDelayMs ?? REQUEST_DELAY_MS;
}

function getAdaptiveBlockSpan(options: SqdRequestOptions) {
  const requested = options.maxBlockSpan ?? DEFAULT_MAX_BLOCK_SPAN;
  return Math.max(MIN_BLOCK_SPAN, Math.floor(requested));
}

function getMinimumBlockSpan(options: SqdRequestOptions) {
  const configured = options.minBlockSpan ?? MIN_BLOCK_SPAN;
  return Math.max(1, Math.floor(configured));
}

function getRecentWindowBlocks(options: SqdRequestOptions) {
  const configured = options.recentWindowBlocks ?? DEFAULT_RECENT_WINDOW_BLOCKS;
  return Math.max(1, Math.floor(configured));
}

function getResponseRetryAfter(response: Response) {
  return parseRetryAfter(response.headers.get('retry-after'));
}

function isRetriableRequestError(error: unknown) {
  if (error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('timeout')
    || message.includes('timed out')
    || message.includes('socket hang up')
    || message.includes('econnreset')
    || message.includes('fetch failed')
    || message.includes('abort');
}

class SqdHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null) {
    super(`SQD request failed with status ${status}`);
    this.name = 'SqdHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
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
        const retryAfter = getResponseRetryAfter(response);
        if (attempt < retries - 1 && isRetriableStatus(response.status)) {
          const backoff = retryAfter ?? getRequestDelay(options) * (2 ** attempt);
          await sleep(backoff);
          continue;
        }

        throw new SqdHttpError(response.status, retryAfter);
      }

      return await response.text();
    } catch (error) {
      if (attempt >= retries - 1) {
        throw error;
      }

      await sleep(getRequestDelay(options) * (2 ** attempt));
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
    maxResults?: number;
  } = {},
): Promise<SqdEthereumSwapLog[] | null> {
  const normalizedAddress = poolAddress.trim().toLowerCase();
  const topic0 = (options.topic0 ?? DEFAULT_SWAP_TOPIC0).toLowerCase();
  const baseUrl = getBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = options.signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS) : null;
  const mergedSignal = options.signal ?? controller?.signal;

  try {
    const latestHeight = options.skipHeightLookup
      ? options.toBlock ?? options.fromBlock ?? 12_376_729
      : Number.parseInt(
          await requestText(`${baseUrl}/height`, { method: 'GET' }, { ...options, fetchImpl, signal: mergedSignal }),
          10,
        );
    const lastBlock = options.toBlock ?? latestHeight;
    const defaultFromBlock = Math.max(12_376_729, lastBlock - getRecentWindowBlocks(options) + 1);
    const requestedFromBlock = options.fromBlock ?? Math.min(defaultFromBlock, lastBlock);
    const fromBlock = Math.max(0, Math.min(requestedFromBlock, lastBlock));
    const maxResults = options.maxResults && options.maxResults > 0
      ? Math.floor(options.maxResults)
      : null;

    if (!Number.isFinite(latestHeight) || latestHeight < fromBlock) {
      return [];
    }

    const results: SqdEthereumSwapLog[] = [];
    let nextBlock = fromBlock;
    let blockSpan = Math.min(getAdaptiveBlockSpan(options), Math.max(1, lastBlock - nextBlock + 1));
    const minBlockSpan = getMinimumBlockSpan(options);

    while (nextBlock <= lastBlock) {
      const windowToBlock = Math.min(lastBlock, nextBlock + blockSpan - 1);

      let blocks: SqdWorkerBlock[];
      try {
        const workerUrl = await requestText(
          `${baseUrl}/${nextBlock}/worker`,
          { method: 'GET' },
          { ...options, fetchImpl, signal: mergedSignal },
        );
        const body = JSON.stringify({
          fromBlock: nextBlock,
          toBlock: windowToBlock,
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
            headers: SQD_BROWSER_HEADERS,
            body,
          },
          { ...options, fetchImpl, signal: mergedSignal },
        );
        blocks = JSON.parse(responseText) as SqdWorkerBlock[];
      } catch (error) {
        const retriableStatus = error instanceof SqdHttpError && isRetriableStatus(error.status);
        if ((retriableStatus || isRetriableRequestError(error)) && blockSpan > minBlockSpan) {
          const shrunkSpan = Math.max(minBlockSpan, Math.floor(blockSpan / 2));
          if (shrunkSpan < blockSpan) {
            const retryAfterMs = error instanceof SqdHttpError
              ? error.retryAfterMs
              : null;
            await sleep(retryAfterMs ?? getRequestDelay(options));
            blockSpan = shrunkSpan;
            continue;
          }
        }

        throw error;
      }

      if (!Array.isArray(blocks) || blocks.length === 0) {
        return results;
      }

      const pageResult: SqdFetchPageResult = {
        swaps: [],
        reachedBlock: null,
      };

      for (const block of blocks) {
        const blockNumber = typeof block.header?.number === 'number' ? block.header.number : null;
        const blockTimestamp = typeof block.header?.timestamp === 'number' ? block.header.timestamp : null;

        if (blockNumber !== null) {
          pageResult.reachedBlock = blockNumber;
        }

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

          pageResult.swaps.push({
            blockNumber,
            blockTimestamp,
            txHash,
            ...decoded,
          });

          if (maxResults !== null && results.length + pageResult.swaps.length >= maxResults) {
            break;
          }
        }

        if (maxResults !== null && results.length + pageResult.swaps.length >= maxResults) {
          break;
        }
      }

      if (pageResult.swaps.length > 0) {
        results.push(...pageResult.swaps);
      }

      if (maxResults !== null && results.length >= maxResults) {
        return results.slice(0, maxResults);
      }

      const lastProcessedBlock = pageResult.reachedBlock;
      if (typeof lastProcessedBlock !== 'number' || lastProcessedBlock < nextBlock) {
        break;
      }

      nextBlock = lastProcessedBlock + 1;
      if (nextBlock <= lastBlock) {
        await sleep(getRequestDelay(options));
      }
    }

    return results;
  } catch (error) {
    logSqdFailure('Failed to fetch SQD Ethereum swap logs', error);
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
