import * as fs from 'fs';
import { resolveSafeWorkspacePath } from './pathSafety';

export interface ReadFileInput {
  filePath: string;
  startLine?: number;
  endLine?: number;
}

export interface ReadFileResult {
  filePath: string;
  totalLines: number;
  content: string;
}

export function readFileTool(input: ReadFileInput): ReadFileResult {
  const safePath = resolveSafeWorkspacePath(input.filePath);
  if (!fs.existsSync(safePath)) {
    throw new Error(`File not found: "${input.filePath}"`);
  }

  const stat = fs.statSync(safePath);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory, not a file: "${input.filePath}"`);
  }

  const raw = fs.readFileSync(safePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;

  const start = Math.max(1, input.startLine ?? 1);
  const end = Math.min(totalLines, input.endLine ?? totalLines);

  const selectedLines: string[] = [];
  for (let i = start; i <= end; i++) {
    selectedLines.push(`${i}: ${lines[i - 1]}`);
  }

  return {
    filePath: input.filePath,
    totalLines,
    content: selectedLines.join('\n'),
  };
}

