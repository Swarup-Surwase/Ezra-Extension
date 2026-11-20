import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseMentions } from './mentionParser';
import { BudgetEnforcer, BudgetReport, ContextSnippet } from './budgetEnforcer';
import { resolveSafeWorkspacePath, getWorkspaceRoots } from '../tools/pathSafety';
import { getConfig } from '../config';

export interface DiscoveredFileItem {
  filePath: string;
  reason: string;
  score: number;
}

export interface AssembledContext {
  promptText: string;
  contextHeader: string;
  discoveredFiles: DiscoveredFileItem[];
  budgetReport: BudgetReport;
}

export class ContextRetriever {
  /**
   * Retrieves bounded relevant context from the workspace for a user instruction.
   * Never concatenates the whole repository. Employs:
   * 1. Explicit @file and @symbol mentions
   * 2. Active editor file & selection
   * 3. Keyword / symbol ranking across repository inventory
   * 4. Bounded snippet extraction around relevance anchors
   * 5. Strict token/character budget enforcement
   */
  public async assembleContext(userPrompt: string): Promise<AssembledContext> {
    const cfg = getConfig();
    const roots = getWorkspaceRoots();
    const primaryRoot = roots[0];

    const mentions = parseMentions(userPrompt);
    const candidateSnippets: ContextSnippet[] = [];
    const discoveredFilesMap = new Map<string, DiscoveredFileItem>();

    // 1. Process explicit @file mentions
    for (const fileMention of mentions.fileMentions) {
      try {
        const safePath = resolveSafeWorkspacePath(fileMention);
        if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
          const content = fs.readFileSync(safePath, 'utf8');
          const lines = content.split(/\r?\n/);
          const snippetLines = lines.slice(0, 100).map((l, i) => `${i + 1}: ${l}`).join('\n');
          candidateSnippets.push({
            filePath: fileMention,
            startLine: 1,
            endLine: Math.min(100, lines.length),
            content: snippetLines,
            reason: `Explicitly mentioned via @${fileMention}`,
            priorityScore: 100,
          });
          discoveredFilesMap.set(fileMention, {
            filePath: fileMention,
            reason: `Explicit mention (@${fileMention})`,
            score: 100,
          });
        }
      } catch {
        // Skip unresolvable mentions
      }
    }

    // 2. Process active editor context (if open)
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const activeUri = activeEditor.document.uri;
      if (activeUri.scheme === 'file') {
        const activePath = activeUri.fsPath;
        const relPath = path.relative(primaryRoot, activePath);
        if (!discoveredFilesMap.has(relPath)) {
          const selection = activeEditor.selection;
          const startLine = Math.max(0, selection.start.line - 15);
          const endLine = Math.min(activeEditor.document.lineCount - 1, selection.end.line + 15);
          const snippetText = activeEditor.document.getText(
            new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine, Number.MAX_SAFE_INTEGER))
          );
          candidateSnippets.push({
            filePath: relPath,
            startLine: startLine + 1,
            endLine: endLine + 1,
            content: snippetText,
            reason: 'Active editor document & cursor selection',
            priorityScore: 90,
          });
          discoveredFilesMap.set(relPath, {
            filePath: relPath,
            reason: 'Active editor document',
            score: 90,
          });
        }
      }
    }

    // 3. Automated keyword & symbol discovery if query terms exist
    const keywords = this.extractKeywords(userPrompt);
    for (const kw of keywords.slice(0, 5)) {
      // Search symbols matching keyword
      try {
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          kw
        );
        if (symbols && Array.isArray(symbols)) {
          for (const s of symbols.slice(0, 3)) {
            const fsPath = s.location.uri.fsPath;
            const rel = path.relative(primaryRoot, fsPath);
            if (!discoveredFilesMap.has(rel) && discoveredFilesMap.size < cfg.maxDiscoveredFiles) {
              if (fs.existsSync(fsPath)) {
                const content = fs.readFileSync(fsPath, 'utf8');
                const lines = content.split(/\r?\n/);
                const symLine = s.location.range.start.line;
                const start = Math.max(0, symLine - 10);
                const end = Math.min(lines.length - 1, symLine + 30);
                const snippet = lines.slice(start, end + 1).map((l, i) => `${start + i + 1}: ${l}`).join('\n');

                candidateSnippets.push({
                  filePath: rel,
                  startLine: start + 1,
                  endLine: end + 1,
                  content: snippet,
                  reason: `Symbol "${s.name}" matches query keyword "${kw}"`,
                  priorityScore: 75,
                });

                discoveredFilesMap.set(rel, {
                  filePath: rel,
                  reason: `Symbol match: "${s.name}" (${kw})`,
                  score: 75,
                });
              }
            }
          }
        }
      } catch {
        // Continue
      }
    }

    // 4. File name heuristic matching (e.g. cli, helpers, config, test_cli)
    for (const kw of keywords) {
      if (discoveredFilesMap.size >= cfg.maxDiscoveredFiles) {
        break;
      }
      const uris = await vscode.workspace.findFiles(
        `**/*${kw}*`,
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/__pycache__/**}',
        3
      );
      for (const u of uris) {
        const rel = path.relative(primaryRoot, u.fsPath);
        if (!discoveredFilesMap.has(rel) && discoveredFilesMap.size < cfg.maxDiscoveredFiles) {
          try {
            const content = fs.readFileSync(u.fsPath, 'utf8');
            const lines = content.split(/\r?\n/);
            const snippet = lines.slice(0, 50).map((l, i) => `${i + 1}: ${l}`).join('\n');
            candidateSnippets.push({
              filePath: rel,
              startLine: 1,
              endLine: Math.min(50, lines.length),
              content: snippet,
              reason: `File path matches query keyword "${kw}"`,
              priorityScore: 60,
            });
            discoveredFilesMap.set(rel, {
              filePath: rel,
              reason: `Path match for "${kw}"`,
              score: 60,
            });
          } catch {
            // Skip
          }
        }
      }
    }

    // 5. Enforce token budget
    const enforcer = new BudgetEnforcer(cfg.contextBudgetTokens);
    const budgetReport = enforcer.enforce(candidateSnippets);

    // Build context header
    const contextHeader = this.formatContextHeader(budgetReport, Array.from(discoveredFilesMap.values()));

    return {
      promptText: userPrompt,
      contextHeader,
      discoveredFiles: Array.from(discoveredFilesMap.values()),
      budgetReport,
    };
  }

  private extractKeywords(prompt: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
      'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do',
      'does', 'did', 'will', 'would', 'should', 'can', 'could', 'add', 'update', 'modify',
      'create', 'change', 'new', 'code', 'file', 'files', 'please', 'must', 'also', 'well'
    ]);

    const words = prompt
      .toLowerCase()
      .replace(/[^a-zA-Z0-9_\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    return Array.from(new Set(words));
  }

  private formatContextHeader(report: BudgetReport, files: DiscoveredFileItem[]): string {
    const fileList = files.map((f) => `- ${f.filePath} (${f.reason})`).join('\n');
    const snippetBlocks = report.includedSnippets
      .map(
        (s) => `### File: ${s.filePath} (lines ${s.startLine}-${s.endLine})\nReason: ${s.reason}\n\`\`\`\n${s.content}\n\`\`\``
      )
      .join('\n\n');

    return `## Relevant Workspace Context
Budget Usage: ${report.usedTokens} / ${report.maxTokens} tokens (${report.budgetPercentage}%)

### Discovered Relevant Files:
${fileList || 'None automatically discovered. Use tools (file_search, grep_search, read_file) to inspect the repository.'}

### Bounded Relevant Code Snippets:
${snippetBlocks || 'No pre-loaded snippets.'}
`;
  }
}

export const contextRetriever = new ContextRetriever();

