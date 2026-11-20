export interface ContextSnippet {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  reason: string;
  priorityScore: number;
}

export interface BudgetReport {
  usedTokens: number;
  maxTokens: number;
  usedChars: number;
  maxChars: number;
  budgetPercentage: number;
  includedSnippets: ContextSnippet[];
  omittedCount: number;
}

export class BudgetEnforcer {
  private maxTokens: number;
  private maxChars: number;

  constructor(maxTokens = 16000) {
    this.maxTokens = maxTokens;
    this.maxChars = maxTokens * 4; // Approx 4 chars per token
  }

  public estimateTokens(text: string): number {
    return Math.ceil((text || '').length / 4);
  }

  public enforce(snippets: ContextSnippet[]): BudgetReport {
    // Sort snippets descending by priority score
    const sorted = [...snippets].sort((a, b) => b.priorityScore - a.priorityScore);

    const included: ContextSnippet[] = [];
    let currentChars = 0;
    let omittedCount = 0;

    for (const snippet of sorted) {
      const snippetChars = snippet.content.length + snippet.filePath.length + snippet.reason.length + 50;
      if (currentChars + snippetChars <= this.maxChars) {
        included.push(snippet);
        currentChars += snippetChars;
      } else {
        omittedCount++;
      }
    }

    const usedTokens = this.estimateTokens(included.map((s) => s.content).join('\n'));

    return {
      usedTokens,
      maxTokens: this.maxTokens,
      usedChars: currentChars,
      maxChars: this.maxChars,
      budgetPercentage: Math.min(100, Math.round((usedTokens / this.maxTokens) * 100)),
      includedSnippets: included,
      omittedCount,
    };
  }
}

