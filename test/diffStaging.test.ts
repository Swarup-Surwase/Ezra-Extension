import * as assert from 'assert';
import { parseFileDiff } from '../src/diff/diffParser';
import { DiffReviewStore } from '../src/diff/diffReviewStore';

export function runDiffStagingTests(): void {
  console.log('--- Running Diff Staging & Hunk Tests ---');

  const originalCode = `def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no"})
`;

  const proposedCode = `def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled.
    Values treated as false: '0', 'false', 'no', 'off', 'n'.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})
`;

  // Test 1: Parse diff into hunks
  const fileDiff = parseFileDiff('src/flask/helpers.py', '/mock/helpers.py', originalCode, proposedCode);
  assert.ok(fileDiff.hunks.length > 0, 'Should generate at least one hunk');
  assert.strictEqual(fileDiff.filePath, 'src/flask/helpers.py');
  assert.strictEqual(fileDiff.status, 'pending');
  console.log(`✓ Parsed diff into ${fileDiff.hunks.length} hunk(s) with pending status`);

  // Test 2: Diff review store staging
  const store = new DiffReviewStore();
  store.stageDiff(fileDiff);
  assert.strictEqual(store.getDiffs().length, 1);
  assert.strictEqual(store.hasPendingDiffs(), true);
  console.log('✓ Diff staged in DiffReviewStore');

  // Test 3: Individual hunk accept / reject
  const firstHunk = fileDiff.hunks[0];
  store.acceptHunk(firstHunk.id);
  assert.strictEqual(firstHunk.status, 'accepted');
  console.log('✓ Individual hunk accepted');

  // Test 4: Accept all
  store.acceptAll();
  assert.ok(fileDiff.hunks.every((h) => h.status === 'accepted'));
  console.log('✓ Accept all hunks verified');

  // Test 5: Reject all
  store.rejectAll();
  assert.ok(fileDiff.hunks.every((h) => h.status === 'rejected'));
  console.log('✓ Reject all hunks verified');

  // Test 6: Clear store
  store.clear();
  assert.strictEqual(store.getDiffs().length, 0);
  console.log('✓ Diff store cleared');
}

