import * as vscode from 'vscode';
import { DiffHunk, FileDiff } from './types';

export class DiffReviewStore {
  private stagedDiffs: Map<string, FileDiff> = new Map();
  private _onDidChangeDiffs = new vscode.EventEmitter<FileDiff[]>();
  public readonly onDidChangeDiffs = this._onDidChangeDiffs.event;

  public stageDiff(fileDiff: FileDiff): void {
    this.stagedDiffs.set(fileDiff.filePath, fileDiff);
    this._onDidChangeDiffs.fire(this.getDiffs());
  }

  public getDiffs(): FileDiff[] {
    return Array.from(this.stagedDiffs.values());
  }

  public getDiff(filePath: string): FileDiff | undefined {
    return this.stagedDiffs.get(filePath);
  }

  public getHunkById(hunkId: string): { hunk: DiffHunk; fileDiff: FileDiff } | undefined {
    for (const fileDiff of this.stagedDiffs.values()) {
      const hunk = fileDiff.hunks.find((h) => h.id === hunkId);
      if (hunk) {
        return { hunk, fileDiff };
      }
    }
    return undefined;
  }

  public acceptHunk(hunkId: string): void {
    const found = this.getHunkById(hunkId);
    if (!found) {
      return;
    }
    found.hunk.status = 'accepted';
    this.updateFileDiffStatus(found.fileDiff);
    this._onDidChangeDiffs.fire(this.getDiffs());
  }

  public rejectHunk(hunkId: string): void {
    const found = this.getHunkById(hunkId);
    if (!found) {
      return;
    }
    found.hunk.status = 'rejected';
    this.updateFileDiffStatus(found.fileDiff);
    this._onDidChangeDiffs.fire(this.getDiffs());
  }

  public acceptAll(): void {
    for (const fileDiff of this.stagedDiffs.values()) {
      for (const hunk of fileDiff.hunks) {
        hunk.status = 'accepted';
      }
      fileDiff.status = 'accepted';
    }
    this._onDidChangeDiffs.fire(this.getDiffs());
  }

  public rejectAll(): void {
    for (const fileDiff of this.stagedDiffs.values()) {
      for (const hunk of fileDiff.hunks) {
        hunk.status = 'rejected';
      }
      fileDiff.status = 'rejected';
    }
    this._onDidChangeDiffs.fire(this.getDiffs());
  }

  public hasPendingDiffs(): boolean {
    for (const fileDiff of this.stagedDiffs.values()) {
      if (fileDiff.hunks.some((h) => h.status === 'pending')) {
        return true;
      }
    }
    return false;
  }

  public clear(): void {
    this.stagedDiffs.clear();
    this._onDidChangeDiffs.fire([]);
  }

  private updateFileDiffStatus(fileDiff: FileDiff): void {
    const allAccepted = fileDiff.hunks.every((h) => h.status === 'accepted');
    const allRejected = fileDiff.hunks.every((h) => h.status === 'rejected');
    if (allAccepted) {
      fileDiff.status = 'accepted';
    } else if (allRejected) {
      fileDiff.status = 'rejected';
    } else {
      fileDiff.status = 'partially_accepted';
    }
  }
}

export const diffReviewStore = new DiffReviewStore();

