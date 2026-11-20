import * as vscode from 'vscode';
import * as fs from 'fs';
import { calculateHash } from './diffParser';
import { diffReviewStore } from './diffReviewStore';
import { revertManager } from './revertManager';
import { FileDiff } from './types';

export interface ApplyResult {
  success: boolean;
  appliedFiles: string[];
  skippedFiles: string[];
  error?: string;
}

export class DiffApplier {
  /**
   * Applies all accepted hunks from the staged diffs.
   * Unapproved (pending or rejected) hunks are omitted, leaving that code untouched.
   * Verifies source file hash before applying to prevent race conditions or overwriting concurrent edits.
   * Applied edits are undoable via VS Code's WorkspaceEdit undo stack.
   */
  public async applyApprovedHunks(description = 'TrueForge agent proposed changes'): Promise<ApplyResult> {
    const diffs = diffReviewStore.getDiffs();
    const appliedFiles: string[] = [];
    const skippedFiles: string[] = [];

    const workspaceEdit = new vscode.WorkspaceEdit();
    const backupRecords: Array<{ filePath: string; beforeContent: string; afterContent: string }> = [];

    for (const fileDiff of diffs) {
      const acceptedHunks = fileDiff.hunks.filter((h) => h.status === 'accepted');
      if (acceptedHunks.length === 0) {
        skippedFiles.push(fileDiff.filePath);
        continue;
      }

      const fileUri = vscode.Uri.file(fileDiff.absolutePath);

      // Verify file state
      let currentContent = '';
      if (fs.existsSync(fileDiff.absolutePath)) {
        currentContent = fs.readFileSync(fileDiff.absolutePath, 'utf8');
      }

      const currentHash = calculateHash(currentContent);
      if (currentHash !== fileDiff.originalHash) {
        const choice = await vscode.window.showWarningMessage(
          `File "${fileDiff.filePath}" was modified externally since the diff was proposed. Overwrite anyway?`,
          'Apply Anyway',
          'Skip File'
        );
        if (choice !== 'Apply Anyway') {
          skippedFiles.push(fileDiff.filePath);
          continue;
        }
      }

      // Reconstruct file with only accepted hunks
      const targetContent = this.computeContentWithAcceptedHunks(fileDiff);

      // Replace entire document content using WorkspaceEdit
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(Number.MAX_SAFE_INTEGER, 0)
      );

      workspaceEdit.replace(fileUri, fullRange, targetContent);

      backupRecords.push({
        filePath: fileDiff.absolutePath,
        beforeContent: currentContent,
        afterContent: targetContent,
      });

      appliedFiles.push(fileDiff.filePath);
    }

    if (appliedFiles.length === 0) {
      return {
        success: true,
        appliedFiles: [],
        skippedFiles,
      };
    }

    // Apply the transactional edit in VS Code
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      return {
        success: false,
        appliedFiles: [],
        skippedFiles,
        error: 'VS Code workspace.applyEdit failed.',
      };
    }

    // Save modified files
    for (const fileDiff of diffs) {
      if (appliedFiles.includes(fileDiff.filePath)) {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fileDiff.absolutePath));
          await doc.save();
        } catch (e) {
          console.warn('[DiffApplier] Save document notice:', e);
        }
      }
    }

    // Record for revert
    revertManager.recordEdit({
      id: `edit_${Date.now()}`,
      timestamp: Date.now(),
      description,
      files: backupRecords,
    });

    // Clear applied diffs from staging store
    diffReviewStore.clear();

    return {
      success: true,
      appliedFiles,
      skippedFiles,
    };
  }

  /**
   * Reconstructs the file content applying only accepted hunks, leaving rejected or pending hunks as original.
   */
  private computeContentWithAcceptedHunks(fileDiff: FileDiff): string {
    // If all hunks are accepted, proposedContent is exact
    const allAccepted = fileDiff.hunks.every((h) => h.status === 'accepted');
    if (allAccepted) {
      return fileDiff.proposedContent;
    }

    // Line-by-line reconstruction from original lines
    const originalLines = fileDiff.originalContent.split(/\r?\n/);
    const resultLines: string[] = [];
    let currentLineIndex = 1; // 1-based

    // Sort hunks by oldStart ascending
    const sortedHunks = [...fileDiff.hunks].sort((a, b) => a.oldStart - b.oldStart);

    for (const hunk of sortedHunks) {
      // Push original lines before this hunk
      while (currentLineIndex < hunk.oldStart && currentLineIndex <= originalLines.length) {
        resultLines.push(originalLines[currentLineIndex - 1]);
        currentLineIndex++;
      }

      if (hunk.status === 'accepted') {
        // Use new lines
        if (hunk.newContent.length > 0) {
          resultLines.push(...hunk.newContent.split(/\r?\n/));
        }
      } else {
        // Keep original lines
        for (let i = 0; i < hunk.oldLines; i++) {
          if (currentLineIndex <= originalLines.length) {
            resultLines.push(originalLines[currentLineIndex - 1]);
            currentLineIndex++;
          }
        }
        continue;
      }

      // Advance line index past original lines replaced by this hunk
      currentLineIndex += hunk.oldLines;
    }

    // Push any remaining original lines
    while (currentLineIndex <= originalLines.length) {
      resultLines.push(originalLines[currentLineIndex - 1]);
      currentLineIndex++;
    }

    return resultLines.join('\n');
  }
}

export const diffApplier = new DiffApplier();

