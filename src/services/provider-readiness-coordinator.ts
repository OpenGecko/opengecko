export type ReadinessBudgetTimeout = { status: 'timeout' };

export type BudgetedProviderFanoutProgress<TItem> = {
  onStart?: (item: TItem, index: number) => void;
  onComplete?: (item: TItem, index: number, durationMs: number) => void;
  onFailure?: (item: TItem, index: number, error: Error, durationMs: number) => void;
};

export type BudgetedProviderFanoutOptions<TItem, TResult> = BudgetedProviderFanoutProgress<TItem> & {
  items: readonly TItem[];
  concurrency: number;
  budgetMs?: number;
  run: (item: TItem, index: number) => Promise<TResult>;
  buildBudgetError: (item: TItem, index: number, budgetMs: number) => Error;
  reportBudgetFailure?: boolean;
};

function normalizeReadinessConcurrency(concurrency: number, itemCount: number) {
  if (itemCount === 0) {
    return 0;
  }

  return Math.min(Math.max(1, Math.floor(concurrency)), itemCount);
}

function toReadinessError(reason: unknown) {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function settleMissingBudgetResults<TItem, TResult>(
  options: Pick<BudgetedProviderFanoutOptions<TItem, TResult>, 'items' | 'buildBudgetError' | 'onFailure' | 'reportBudgetFailure'>,
  results: Array<PromiseSettledResult<TResult> | undefined>,
  budgetMs: number,
) {
  for (let index = 0; index < options.items.length; index++) {
    if (results[index]) {
      continue;
    }

    const item = options.items[index];
    const error = options.buildBudgetError(item, index, budgetMs);
    results[index] = { status: 'rejected', reason: error };

    if (options.reportBudgetFailure) {
      options.onFailure?.(item, index, error, budgetMs);
    }
  }
}

export async function runBudgetedProviderFanout<TItem, TResult>(
  options: BudgetedProviderFanoutOptions<TItem, TResult>,
): Promise<PromiseSettledResult<TResult>[]> {
  if (options.items.length === 0) {
    return [];
  }

  const concurrency = normalizeReadinessConcurrency(options.concurrency, options.items.length);
  const budgetMs = options.budgetMs;
  const results = new Array<PromiseSettledResult<TResult> | undefined>(options.items.length);
  let nextIndex = 0;
  let activeWorkers = 0;
  let settledWorkers = 0;
  let resolved = false;
  let budgetTimer: ReturnType<typeof setTimeout> | null = null;

  return await new Promise<PromiseSettledResult<TResult>[]>((resolve) => {
    const resolveOnce = () => {
      if (resolved) {
        return;
      }

      resolved = true;
      if (budgetTimer) {
        clearTimeout(budgetTimer);
        budgetTimer = null;
      }
      if (budgetMs && budgetMs > 0) {
        settleMissingBudgetResults(options, results, budgetMs);
      }
      resolve(Array.from({ length: options.items.length }, (_, index) => results[index] ?? {
        status: 'rejected',
        reason: options.buildBudgetError(options.items[index], index, budgetMs ?? 0),
      }));
    };

    const startNext = () => {
      if (resolved) {
        return;
      }

      while (activeWorkers < concurrency && nextIndex < options.items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        activeWorkers += 1;
        const item = options.items[currentIndex];
        const startedAt = Date.now();
        options.onStart?.(item, currentIndex);

        Promise.resolve(options.run(item, currentIndex))
          .then((value) => {
            if (resolved) {
              return;
            }

            const durationMs = Date.now() - startedAt;
            results[currentIndex] = { status: 'fulfilled', value };
            options.onComplete?.(item, currentIndex, durationMs);
          })
          .catch((reason) => {
            if (resolved) {
              return;
            }

            const durationMs = Date.now() - startedAt;
            const error = toReadinessError(reason);
            results[currentIndex] = { status: 'rejected', reason: error };
            options.onFailure?.(item, currentIndex, error, durationMs);
          })
          .finally(() => {
            activeWorkers -= 1;
            settledWorkers += 1;

            if (settledWorkers === options.items.length) {
              resolveOnce();
              return;
            }

            startNext();
          });
      }
    };

    if (budgetMs && budgetMs > 0) {
      budgetTimer = setTimeout(resolveOnce, budgetMs);
    }

    startNext();
  });
}

export async function raceWithReadinessBudget<T>(
  operation: Promise<T>,
  remainingBudgetMs: number,
): Promise<T | ReadinessBudgetTimeout> {
  if (remainingBudgetMs <= 0) {
    return { status: 'timeout' };
  }

  return await Promise.race([
    operation,
    new Promise<ReadinessBudgetTimeout>((resolve) => {
      setTimeout(() => resolve({ status: 'timeout' }), remainingBudgetMs);
    }),
  ]);
}

export function isReadinessBudgetTimeout<T>(
  result: T | ReadinessBudgetTimeout,
): result is ReadinessBudgetTimeout {
  return typeof result === 'object' && result !== null && 'status' in result && result.status === 'timeout';
}
