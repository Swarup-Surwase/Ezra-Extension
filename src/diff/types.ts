export type HunkStatus = 'pending' | 'accepted' | 'rejected';
export type FileDiffStatus = 'pending' | 'partially_accepted' | 'accepted' | 'rejected';

export interface DiffHunk {
  id: string;
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  oldContent: string;
  newContent: string;
  header: string;
  status: HunkStatus;
}

export interface FileDiff {
  filePath: string;
  absolutePath: string;
  originalContent: string;
  proposedContent: string;
  originalHash: string;
  hunks: DiffHunk[];
  status: FileDiffStatus;
}

export interface AppliedEditRecord {
  id: string;
  timestamp: number;
  description: string;
  files: Array<{
    filePath: string;
    beforeContent: string;
    afterContent: string;
  }>;
}

