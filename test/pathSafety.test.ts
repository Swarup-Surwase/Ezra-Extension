import * as assert from 'assert';
import * as path from 'path';
import { resolveSafeWorkspacePath, PathSecurityError } from '../src/tools/pathSafety';

export function runPathSafetyTests(): void {
  console.log('--- Running Path Safety Tests ---');

  // Test 1: Relative path inside workspace resolves properly
  const safeRelative = resolveSafeWorkspacePath('src/extension.ts');
  assert.ok(safeRelative.includes('src/extension.ts'), 'Safe relative path should resolve');
  console.log('✓ Safe relative path resolves inside workspace');

  // Test 2: Directory traversal attack rejection (../ outside workspace)
  assert.throws(
    () => {
      resolveSafeWorkspacePath('../../../../../../../etc/passwd');
    },
    (err: any) => err instanceof PathSecurityError,
    'Should throw PathSecurityError for traversal to /etc/passwd'
  );
  console.log('✓ Directory traversal attack rejected with PathSecurityError');

  // Test 3: Absolute path outside workspace rejection
  assert.throws(
    () => {
      resolveSafeWorkspacePath('/etc/shadow');
    },
    (err: any) => err instanceof PathSecurityError,
    'Should throw PathSecurityError for absolute path outside workspace'
  );
  console.log('✓ Absolute path outside workspace rejected');

  // Test 4: Nested traversal rejection
  assert.throws(
    () => {
      resolveSafeWorkspacePath('src/../../../../Desktop/secret.txt');
    },
    (err: any) => err instanceof PathSecurityError,
    'Should throw PathSecurityError for nested traversal'
  );
  console.log('✓ Nested traversal rejected');
}

