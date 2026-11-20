import * as assert from 'assert';
import { parseMentions } from '../src/context/mentionParser';
import { BudgetEnforcer, ContextSnippet } from '../src/context/budgetEnforcer';

export function runContextBudgetTests(): void {
  console.log('--- Running Context Assembly & Budget Tests ---');

  // Test 1: Explicit @file and @symbol mention parsing
  const prompt = 'Please inspect @src/flask/helpers.py and update @get_debug_flag to support off and n';
  const mentions = parseMentions(prompt);
  assert.ok(mentions.fileMentions.includes('src/flask/helpers.py'), 'Should extract file mention');
  assert.ok(mentions.symbolMentions.includes('get_debug_flag'), 'Should extract symbol mention');
  console.log('✓ Explicit @file and @symbol mentions parsed accurately');

  // Test 2: Budget enforcement
  const enforcer = new BudgetEnforcer(100); // Small 100 token (~400 char) budget for testing
  const snippets: ContextSnippet[] = [
    {
      filePath: 'file1.py',
      startLine: 1,
      endLine: 10,
      content: 'a'.repeat(200),
      reason: 'High priority match',
      priorityScore: 90,
    },
    {
      filePath: 'file2.py',
      startLine: 1,
      endLine: 10,
      content: 'b'.repeat(250),
      reason: 'Medium priority match',
      priorityScore: 70,
    },
    {
      filePath: 'file3.py',
      startLine: 1,
      endLine: 10,
      content: 'c'.repeat(300),
      reason: 'Low priority match',
      priorityScore: 40,
    },
  ];

  const report = enforcer.enforce(snippets);
  assert.ok(report.usedChars <= report.maxChars, 'Enforced chars must not exceed max');
  assert.ok(report.includedSnippets.length >= 1, 'Highest priority snippet must be included');
  assert.strictEqual(report.includedSnippets[0].filePath, 'file1.py', 'Highest score must be first');
  assert.ok(report.omittedCount > 0, 'Excess snippets must be omitted');
  console.log(`✓ Budget enforced: ${report.usedTokens}/${report.maxTokens} tokens, ${report.omittedCount} omitted`);
}

