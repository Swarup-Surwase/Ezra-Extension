import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TrueForgeClient } from '../transport/TrueForgeClient';
import { diffReviewStore } from '../diff/diffReviewStore';
import { diffApplier } from '../diff/diffApplier';
import { parseFileDiff } from '../diff/diffParser';
import { getConfig } from '../config';
import { ModelFallbackManager } from '../resilience/modelFallbackManager';

export class InlineEditController {
  private client: TrueForgeClient;
  private fallbackManager: ModelFallbackManager;
  private activeAbortController?: AbortController;

  constructor(client: TrueForgeClient, fallbackManager: ModelFallbackManager) {
    this.client = client;
    this.fallbackManager = fallbackManager;
  }

  public async startInlineEdit(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Open a file in the editor to use TrueForge Inline Edit.');
      return;
    }

    const document = editor.document;
    const selection = editor.selection;

    // Handle empty selection gracefully: select current line or line range
    let targetRange: vscode.Range = selection;
    if (selection.isEmpty) {
      const line = document.lineAt(selection.start.line);
      targetRange = new vscode.Range(line.range.start, line.range.end);
    }

    const selectedText = document.getText(targetRange);

    // Prompt user for plain-language instruction
    const prompt = await vscode.window.showInputBox({
      prompt: 'TrueForge: Enter an instruction for the selected code',
      placeHolder: 'e.g. Treat "off" and "n" as false as well, case-insensitively, and update docstring',
      ignoreFocusOut: true,
    });

    if (!prompt || !prompt.trim()) {
      return;
    }

    // Bounded context: selected code + surrounding lines
    const startContextLine = Math.max(0, targetRange.start.line - 25);
    const endContextLine = Math.min(document.lineCount - 1, targetRange.end.line + 25);
    const surroundingContext = document.getText(
      new vscode.Range(new vscode.Position(startContextLine, 0), new vscode.Position(endContextLine, Number.MAX_SAFE_INTEGER))
    );

    const relPath = vscode.workspace.asRelativePath(document.uri);

    const fullInstruction = `You are performing an inline edit on the file "${relPath}".
Selected lines: ${targetRange.start.line + 1} to ${targetRange.end.line + 1}.

User instruction:
${prompt.trim()}

Selected code to edit:
\`\`\`
${selectedText}
\`\`\`

Surrounding context (lines ${startContextLine + 1} to ${endContextLine + 1}):
\`\`\`
${surroundingContext}
\`\`\`

Propose your modification by calling the propose_edit tool for "${relPath}" with oldStr matching the exact code to be replaced and newStr with the updated code.`;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'TrueForge: Generating inline edit...',
        cancellable: true,
      },
      async (progress, token) => {
        this.activeAbortController = new AbortController();
        token.onCancellationRequested(() => {
          this.cancel();
        });

        await vscode.commands.executeCommand('setContext', 'trueforge.agentRunning', true);

        try {
          const cfg = getConfig();
          let currentModel = cfg.modelName;

          // Create session in TrueForge
          let session;
          try {
            session = await this.client.createSession({ name: cfg.agentName });
          } catch (e) {
            session = await this.client.createSession({
              spec: {
                model: { name: currentModel },
                instructions: 'You are a code modification assistant. Propose safe, verified edits using propose_edit.',
                mcpServers: [{ name: 'editor-tools' }],
              },
            });
          }

          // Run stream
          await this.client.createTurnStream(
            session.id,
            fullInstruction,
            (event) => {
              if (event.type === 'model.message.delta') {
                progress.report({ message: 'Streaming response...' });
              }
            },
            this.activeAbortController.signal
          );

          // Check if diffs were proposed
          const staged = diffReviewStore.getDiff(relPath);
          if (!staged || staged.hunks.length === 0) {
            vscode.window.showInformationMessage('TrueForge completed without proposing changes.');
            return;
          }

          // Open diff preview for user review
          await this.presentInlineDiffPreview(document, staged);
        } catch (err: any) {
          if (this.activeAbortController?.signal.aborted) {
            vscode.window.showInformationMessage('TrueForge inline edit cancelled.');
            return;
          }

          // Attempt fallback if configured
          const fallbackModel = await this.fallbackManager.handleModelFailure(err);
          if (fallbackModel) {
            vscode.window.showWarningMessage(
              `Retrying inline edit with TrueForge fallback model "${fallbackModel}"...`
            );
            // Retry with fallback model
            try {
              const session = await this.client.createSession({
                spec: {
                  model: { name: fallbackModel },
                  instructions: 'You are a code modification assistant. Propose safe, verified edits using propose_edit.',
                  mcpServers: [{ name: 'editor-tools' }],
                },
              });
              await this.client.createTurnStream(
                session.id,
                fullInstruction,
                () => {},
                this.activeAbortController.signal
              );
              const staged = diffReviewStore.getDiff(relPath);
              if (staged) {
                await this.presentInlineDiffPreview(document, staged);
              }
            } catch (retryErr: any) {
              vscode.window.showErrorMessage(`TrueForge fallback failed: ${retryErr?.message || retryErr}`);
            }
          } else {
            vscode.window.showErrorMessage(`TrueForge inline edit error: ${err?.message || err}`);
          }
        } finally {
          await vscode.commands.executeCommand('setContext', 'trueforge.agentRunning', false);
          this.activeAbortController = undefined;
        }
      }
    );
  }

  public cancel(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = undefined;
    }
  }

  private async presentInlineDiffPreview(
    originalDoc: vscode.TextDocument,
    fileDiff: any
  ): Promise<void> {
    // Write proposed version to a temporary virtual document for diff viewing
    const proposedUri = vscode.Uri.parse(`untitled:${fileDiff.filePath}.proposed`);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(proposedUri, new vscode.Position(0, 0), fileDiff.proposedContent);
    await vscode.workspace.applyEdit(edit);

    // Open VS Code's side-by-side diff editor
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalDoc.uri,
      proposedUri,
      `${path.basename(fileDiff.filePath)}: Current ↔ TrueForge Proposed`
    );

    // Prompt user to Accept or Reject
    const action = await vscode.window.showInformationMessage(
      `TrueForge proposed ${fileDiff.hunks.length} hunk(s) for "${fileDiff.filePath}".`,
      'Accept All Hunks',
      'Review Individual Hunks',
      'Reject All'
    );

    if (action === 'Accept All Hunks') {
      diffReviewStore.acceptAll();
      await diffApplier.applyApprovedHunks(`Inline edit: ${fileDiff.filePath}`);
      vscode.window.showInformationMessage(`Applied proposed changes to "${fileDiff.filePath}". (Undoable via Cmd+Z)`);
    } else if (action === 'Review Individual Hunks') {
      // Focus the TrueForge Agent panel where individual hunk cards can be clicked
      await vscode.commands.executeCommand('trueforge.agentView.focus');
    } else if (action === 'Reject All') {
      diffReviewStore.rejectAll();
      diffReviewStore.clear();
      vscode.window.showInformationMessage(`Rejected changes for "${fileDiff.filePath}". Workspace untouched.`);
    }
  }
}
