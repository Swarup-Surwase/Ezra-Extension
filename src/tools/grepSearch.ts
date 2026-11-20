import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoots } from './pathSafety';

export interface GrepSearchInput {
  query: string;
  filePattern?: string;
  caseSensitive?: boolean;
  maxMatches?: number;
}

export interface GrepMatch {
  filePath: string;
  lineNumber: number;
  lineContent: string;
  contextSnippet: string;
}

export interface GrepSearchResult {
  query: string;
  matches: GrepMatch[];
  totalMatches: number;
}

export async function grepSearchTool(input: GrepSearchInput): Promise<GrepSearchResult> {
  const query = (input.query || '').trim();
  if (!query) {
    throw new Error('Grep search query cannot be empty.');
  }

  const filePattern = input.filePattern || '**/*';
  const maxMatches = input.maxMatches ?? 30;
  const caseSensitive = input.caseSensitive ?? false;

  const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/__pycache__/**,**/.venv/**,**/.tox/**}';
  const uris = await vscode.workspace.findFiles(filePattern, excludePattern, 200);

  const roots = getWorkspaceRoots();
  const matches: GrepMatch[] = [];

  const regexFlags = caseSensitive ? 'g' : 'gi';
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escapedQuery, regexFlags);

  for (const uri of uris) {
    if (matches.length >= maxMatches) {
      break;
    }

    try {
      const content = fs.readFileSync(uri.fsPath, 'utf8');
      const lines = content.split(/\r?\n/);

      let relPath = uri.fsPath;
      for (const r of roots) {
        if (uri.fsPath.startsWith(r)) {
          relPath = path.relative(r, uri.fsPath);
          break;
        }
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (regex.test(line)) {
          regex.lastIndex = 0;
          const startCtx = Math.max(0, i - 2);
          const endCtx = Math.min(lines.length - 1, i + 2);
          const snippetLines = lines.slice(startCtx, endCtx + 1).map((l, idx) => `${startCtx + idx + 1}: ${l}`);

          matches.push({
            filePath: relPath,
            lineNumber: i + 1,
            lineContent: line.trim(),
            contextSnippet: snippetLines.join('\n'),
          });

          if (matches.length >= maxMatches) {
            break;
          }
        }
      }
    } catch {
      // Skip unreadable files (e.g. binary)
    }
  }

  return {
    query,
    matches,
    totalMatches: matches.length,
  };
}

