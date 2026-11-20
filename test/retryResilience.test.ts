import * as assert from 'assert';
import { withRetry, isTransientError } from '../src/transport/retry';

export async function runRetryResilienceTests(): Promise<void> {
  console.log('--- Running Retry & Resilience Tests ---');

  // Test 1: Transient error detection
  assert.strictEqual(isTransientError({ status: 502 }), true, '502 should be transient');
  assert.strictEqual(isTransientError({ status: 503 }), true, '503 should be transient');
  assert.strictEqual(isTransientError({ status: 408 }), true, '408 should be transient');
  assert.strictEqual(isTransientError({ status: 429 }), true, '429 should be transient');
  assert.strictEqual(isTransientError({ code: 'ECONNRESET' }), true, 'ECONNRESET should be transient');
  assert.strictEqual(isTransientError({ status: 401 }), false, '401 should NOT be transient');
  assert.strictEqual(isTransientError({ status: 404 }), false, '404 should NOT be transient');
  console.log('✓ Transient error classifier verified');

  // Test 2: Successful retry on transient error
  let attempts = 0;
  const result = await withRetry(
    async (attempt) => {
      attempts = attempt;
      if (attempt < 3) {
        const err: any = new Error('Gateway Timeout');
        err.status = 504;
        throw err;
      }
      return 'success';
    },
    { initialDelayMs: 10, maxRetries: 3 }
  );

  assert.strictEqual(result, 'success');
  assert.strictEqual(attempts, 3);
  console.log('✓ Exponential backoff retry succeeded on transient failure');

  // Test 3: Fast-fail on non-transient error
  let fastFailAttempts = 0;
  await assert.rejects(
    async () => {
      await withRetry(
        async (attempt) => {
          fastFailAttempts = attempt;
          const err: any = new Error('Unauthorized');
          err.status = 401;
          throw err;
        },
        { initialDelayMs: 10, maxRetries: 3 }
      );
    },
    (err: any) => err.status === 401,
    '401 should reject immediately without retrying'
  );

  assert.strictEqual(fastFailAttempts, 1, 'Non-transient error should fail on first attempt');
  console.log('✓ Fast-fail on non-transient error verified');
}

