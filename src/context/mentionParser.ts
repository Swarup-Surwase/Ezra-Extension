import * as vscode from 'vscode';
import * as fs from 'fs';
import { resolveSafeWorkspacePath } from '../tools/pathSafety';

export interface MentionResult {
  fileMentions: string[];
  symbolMentions: string[];
  cleanPrompt: string;
}

export function parseMentions(input: string): MentionResult {
  const fileMentions: string[] = [];
  const symbolMentions: string[] = [];

  // Match @patterns: @path/to/file.ext or @symbol_name
  const regex = /@([a-zA-Z0-9_\-./]+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    const candidate = match[1];
    // Check if candidate looks like a file path or existing file
    try {
      const safePath = resolveSafeWorkspacePath(candidate);
      if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
        if (!fileMentions.includes(candidate)) {
          fileMentions.push(candidate);
        }
        continue;
      }
    } catch {
      // Not a valid file path, treat as symbol
    }

    if (candidate.includes('.') && (candidate.endsWith('.py') || candidate.endsWith('.ts') || candidate.endsWith('.js') || candidate.endsWith('.json') || candidate.endsWith('.rst') || candidate.endsWith('.md'))) {
      if (!fileMentions.includes(candidate)) {
        fileMentions.push(candidate);
      }
    } else {
      if (!symbolMentions.includes(candidate)) {
        symbolMentions.push(candidate);
      }
    }
  }

  return {
    fileMentions,
    symbolMentions,
    cleanPrompt: input,
  };
}

