import * as diff from 'diff';
import * as crypto from 'crypto';
import { DiffHunk, FileDiff } from './types';

export function calculateHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function parseFileDiff(
  filePath: string,
  absolutePath: string,
  originalContent: string,
  proposedContent: string
): FileDiff {
  const patch = diff.structuredPatch(
    filePath,
    filePath,
    originalContent,
    proposedContent,
    'original',
    'proposed'
  );

  const hunks: DiffHunk[] = patch.hunks.map((h, index) => {
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const line of h.lines) {
      if (line.startsWith('-')) {
        oldLines.push(line.substring(1));
      } else if (line.startsWith('+')) {
        newLines.push(line.substring(1));
      } else {
        // Context line (starts with ' ' or '')
        const ctx = line.startsWith(' ') ? line.substring(1) : line;
        oldLines.push(ctx);
        newLines.push(ctx);
      }
    }

    const hunkId = `hunk_${crypto.createHash('md5').update(`${filePath}:${index}:${h.oldStart}:${h.newStart}`).digest('hex').substring(0, 8)}`;
    const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;

    return {
      id: hunkId,
      filePath,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      oldContent: oldLines.join('\n'),
      newContent: newLines.join('\n'),
      header,
      status: 'pending',
    };
  });

  return {
    filePath,
    absolutePath,
    originalContent,
    proposedContent,
    originalHash: calculateHash(originalContent),
    hunks,
    status: 'pending',
  };
}

