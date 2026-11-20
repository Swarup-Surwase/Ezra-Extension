export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export function isTransientError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const err = error as { status?: number; statusCode?: number; code?: string; message?: string };
  const status = err.status ?? err.statusCode;
  if (status) {
    if (status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
      return true;
    }
    // 400, 401, 403, 404, 422 are not transient
    if (status >= 400 && status < 500) {
      return false;
    }
  }
  const code = err.code ?? '';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) {
    return true;
  }
  const msg = (err.message ?? '').toLowerCase();
  if (msg.includes('network') || msg.includes('timeout') || msg.includes('socket') || msg.includes('econnrefused')) {
    return true;
  }
  return false;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const factor = options.factor ?? 2;

  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    try {
      attempt++;
      return await operation(attempt);
    } catch (err) {
      if (attempt > maxRetries || !isTransientError(err)) {
        throw err;
      }
      // Calculate delay with jitter
      const jitter = Math.random() * 0.3 * delay;
      const actualDelay = Math.min(maxDelayMs, delay + jitter);
      if (options.onRetry) {
        options.onRetry(attempt, err, actualDelay);
      }
      await new Promise((resolve) => setTimeout(resolve, actualDelay));
      delay = Math.min(maxDelayMs, delay * factor);
    }
  }
}

