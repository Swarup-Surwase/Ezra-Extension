import * as vscode from 'vscode';
import * as path from 'path';
import { getWorkspaceRoots } from './pathSafety';

export interface FileSearchInput {
  query?: string;
  maxResults?: number;
}

export interface FileSearchResult {
  files: string[];
  totalFound: number;
}

export async function fileSearchTool(input: FileSearchInput): Promise<FileSearchResult> {
  const query = (input.query || '').trim();
  const maxResults = input.maxResults ?? 50;

  let pattern = '**/*';
  if (query) {
    if (query.includes('*') || query.includes('?')) {
      pattern = query;
    } else {
      pattern = `**/*${query}*`;
    }
  }

  const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/__pycache__/**,**/.venv/**,**/.tox/**}';
  const uris = await vscode.workspace.findFiles(pattern, excludePattern, maxResults);
  const roots = getWorkspaceRoots();

  const files = uris.map((u) => {
    const fsPath = u.fsPath;
    for (const r of roots) {
      if (fsPath.startsWith(r)) {
        return path.relative(r, fsPath);
      }
    }
    return fsPath;
  });

  return {
    files,
    totalFound: files.length,
  };
}

