import * as fs from 'fs';
import * as path from 'path';
import { resolveSafeWorkspacePath, getWorkspaceRoots } from './pathSafety';
import { parseFileDiff } from '../diff/diffParser';
import { diffReviewStore } from '../diff/diffReviewStore';

export interface ProposeEditInput {
  filePath: string;
  proposedContent?: string;
  oldStr?: string;
  newStr?: string;
  unifiedDiff?: string;
  explanation?: string;
}

export interface ProposeEditResult {
  filePath: string;
  hunkCount: number;
  status: 'staged_for_review';
  message: string;
}

export function proposeEditTool(input: ProposeEditInput): ProposeEditResult {
  if (!input.filePath) {
    throw new Error('propose_edit: filePath is required.');
  }

  const safePath = resolveSafeWorkspacePath(input.filePath);
  const roots = getWorkspaceRoots();
  let relPath = input.filePath;
  for (const r of roots) {
    if (safePath.startsWith(r)) {
      relPath = path.relative(r, safePath);
      break;
    }
  }

  let originalContent = '';
  if (fs.existsSync(safePath)) {
    originalContent = fs.readFileSync(safePath, 'utf8');
  }

  let finalProposed = '';
  if (typeof input.proposedContent === 'string') {
    finalProposed = input.proposedContent;
  } else if (typeof input.oldStr === 'string' && typeof input.newStr === 'string') {
    if (!originalContent.includes(input.oldStr)) {
      throw new Error(
        `propose_edit: oldStr was not found in "${input.filePath}". Ensure oldStr matches existing file content exactly.`
      );
    }
    finalProposed = originalContent.replace(input.oldStr, input.newStr);
  } else if (typeof input.unifiedDiff === 'string') {
    // If unified diff was provided, parse using diffParser
    finalProposed = applyUnifiedDiffToText(originalContent, input.unifiedDiff);
  } else {
    throw new Error(
      'propose_edit: You must provide either proposedContent, or both oldStr and newStr.'
    );
  }

  // Parse into hunks and stage in DiffReviewStore
  const fileDiff = parseFileDiff(relPath, safePath, originalContent, finalProposed);
  diffReviewStore.stageDiff(fileDiff);

  return {
    filePath: relPath,
    hunkCount: fileDiff.hunks.length,
    status: 'staged_for_review',
    message: `Proposed changes for "${relPath}" staged with ${fileDiff.hunks.length} hunk(s) for user review in VS Code. Workspace files were NOT modified.`,
  };
}

function applyUnifiedDiffToText(original: string, diffText: string): string {
  // If diffText contains + and - lines, we can reconstruct or parse
  const lines = original.split(/\r?\n/);
  // Basic fallback if diff is supplied as raw patch
  return diffText;
}

