import * as vscode from 'vscode';
import * as fs from 'fs';
import { AppliedEditRecord } from './types';

export class RevertManager {
  private history: AppliedEditRecord[] = [];

  public recordEdit(record: AppliedEditRecord): void {
    this.history.push(record);
  }

  public getHistory(): AppliedEditRecord[] {
    return [...this.history];
  }

  public getLastEdit(): AppliedEditRecord | undefined {
    return this.history[this.history.length - 1];
  }

  public async revertLastEdit(): Promise<boolean> {
    const last = this.history.pop();
    if (!last) {
      vscode.window.showInformationMessage('No TrueForge edits available to revert.');
      return false;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const f of last.files) {
      const uri = vscode.Uri.file(f.filePath);
      if (fs.existsSync(f.filePath)) {
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          new vscode.Position(Number.MAX_SAFE_INTEGER, 0)
        );
        edit.replace(uri, fullRange, f.beforeContent);
      }
    }

    const success = await vscode.workspace.applyEdit(edit);
    if (success) {
      vscode.window.showInformationMessage(`Reverted TrueForge edit: ${last.description}`);
    } else {
      vscode.window.showErrorMessage(`Failed to revert TrueForge edit: ${last.description}`);
    }
    return success;
  }

  public clear(): void {
    this.history = [];
  }
}

export const revertManager = new RevertManager();

