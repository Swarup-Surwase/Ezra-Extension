import * as vscode from 'vscode';
import { getConfig } from './config';
import { TrueForgeClient } from './transport/TrueForgeClient';
import { editorMcpServer } from './mcp/EditorMcpServer';
import { AgentWebviewProvider } from './ui/agentWebviewProvider';
import { InlineEditController } from './ui/inlineEditController';
import { diffReviewStore } from './diff/diffReviewStore';
import { diffApplier } from './diff/diffApplier';
import { revertManager } from './diff/revertManager';
import { ModelFallbackManager } from './resilience/modelFallbackManager';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[TrueForge] Activating TrueForge Coding Agent extension...');

  const cfg = getConfig();
  const client = new TrueForgeClient({
    baseUrl: cfg.serverUrl,
  });

  const fallbackManager = new ModelFallbackManager(client);
  const inlineController = new InlineEditController(client, fallbackManager);

  // Start embedded MCP server so TrueForge harness can drive editor tools
  if (cfg.enableMcpTools) {
    try {
      const port = await editorMcpServer.start(8920);
      console.log(`[TrueForge] Embedded MCP server started on port ${port}`);

      // Register MCP server with TrueForge
      const mcpUrl = editorMcpServer.getEndpointUrl();
      await client.registerMcpServer(
        'editor-tools',
        mcpUrl,
        'VS Code editor and repository tools (read_file, file_search, grep_search, find_symbols, propose_edit, execute_command)'
      );
    } catch (e) {
      console.warn('[TrueForge] MCP server startup notice:', e);
    }
  }

  // Register Webview View Provider
  const provider = new AgentWebviewProvider(context.extensionUri, client, fallbackManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentWebviewProvider.viewType, provider)
  );

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('trueforge.inlineEdit', async () => {
      await inlineController.startInlineEdit();
    }),

    vscode.commands.registerCommand('trueforge.openAgentPanel', async () => {
      await vscode.commands.executeCommand('trueforge.agentView.focus');
    }),

    vscode.commands.registerCommand('trueforge.reviewDiffs', async () => {
      const diffs = diffReviewStore.getDiffs();
      if (diffs.length === 0) {
        vscode.window.showInformationMessage('No proposed changes currently staged for review.');
        return;
      }
      await vscode.commands.executeCommand('trueforge.agentView.focus');
    }),

    vscode.commands.registerCommand('trueforge.acceptAllHunks', async () => {
      diffReviewStore.acceptAll();
      const result = await diffApplier.applyApprovedHunks('Accepted all TrueForge changes');
      if (result.success && result.appliedFiles.length > 0) {
        vscode.window.showInformationMessage(
          `Applied changes to ${result.appliedFiles.length} file(s). (Undoable via Cmd+Z)`
        );
      }
    }),

    vscode.commands.registerCommand('trueforge.rejectAllHunks', async () => {
      diffReviewStore.rejectAll();
      diffReviewStore.clear();
      vscode.window.showInformationMessage('Rejected all proposed changes. Workspace files untouched.');
    }),

    vscode.commands.registerCommand('trueforge.cancelCurrentRun', () => {
      inlineController.cancel();
      provider.cancelCurrentRun();
      vscode.window.showInformationMessage('TrueForge run cancelled.');
    }),

    vscode.commands.registerCommand('trueforge.revertLastEdit', async () => {
      await revertManager.revertLastEdit();
    }),

    vscode.commands.registerCommand('trueforge.testResilience', async () => {
      const mode = await vscode.window.showQuickPick(
        [
          { label: 'Unreachable Endpoint', description: 'Simulate server network disconnect (Task C)' },
          { label: 'Invalid API Key', description: 'Simulate authentication/quota failure (Task C)' },
        ],
        { placeHolder: 'Select resilience scenario to simulate' }
      );
      if (mode) {
        const testMode = mode.label === 'Unreachable Endpoint' ? 'unreachable' : 'invalid_key';
        await vscode.commands.executeCommand('trueforge.agentView.focus');
        provider.postMessage({ type: 'testResilience', mode: testMode });
      }
    })
  );

  console.log('[TrueForge] TrueForge Coding Agent extension activated successfully.');
}

export function deactivate(): void {
  editorMcpServer.stop();
  diffReviewStore.clear();
}

