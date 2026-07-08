export interface RetryOptions {
  retries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (err: unknown, attempt: number) => void;
}

/** Retry an async operation with exponential backoff + jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const minDelay = opts.minDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      opts.onRetry?.(err, attempt + 1);
      const delay = Math.min(maxDelay, minDelay * 2 ** attempt) * (0.5 + Math.random());
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
