// Pre-register vscode mock for standalone headless test execution
import { mockVscode } from './mockVscode';
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return mockVscode;
  }
  return originalRequire.apply(this, arguments);
};

// Now import test modules
import { runPathSafetyTests } from './pathSafety.test';
import { runDiffStagingTests } from './diffStaging.test';
import { runContextBudgetTests } from './contextBudget.test';
import { runRetryResilienceTests } from './retryResilience.test';
import { runDemoTaskTests } from './demoTasks.test';

async function main(): Promise<void> {
  console.log('====================================================');
  console.log('   TrueForge Coding Agent - Test Suite Execution    ');
  console.log('====================================================\n');

  try {
    runPathSafetyTests();
    console.log('');
    runDiffStagingTests();
    console.log('');
    runContextBudgetTests();
    console.log('');
    await runRetryResilienceTests();
    console.log('');
    runDemoTaskTests();

    console.log('\n====================================================');
    console.log('   ALL TEST SUITES PASSED SUCCESSFULLY (5/5)       ');
    console.log('====================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test failure detected:', err);
    process.exit(1);
  }
}

main();
