import * as vscode from 'vscode';
import * as path from 'path';
import { TrueForgeClient } from '../transport/TrueForgeClient';
import { contextRetriever, AssembledContext } from '../context/contextRetriever';
import { diffReviewStore } from '../diff/diffReviewStore';
import { diffApplier } from '../diff/diffApplier';
import { revertManager } from '../diff/revertManager';
import { ModelFallbackManager } from '../resilience/modelFallbackManager';
import { getConfig } from '../config';
import { DiffHunk, FileDiff } from '../diff/types';
import { ModelMessageDeltaEvent, ToolApprovalRequiredEvent, TurnCreatedEvent } from '../transport/types';

export class AgentWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'trueforge.agentView';
  private _view?: vscode.WebviewView;
  private client: TrueForgeClient;
  private fallbackManager: ModelFallbackManager;
  private abortController?: AbortController;
  private wasCancelled = false;
  private currentSessionId?: string;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    client: TrueForgeClient,
    fallbackManager: ModelFallbackManager
  ) {
    this.client = client;
    this.fallbackManager = fallbackManager;

    // Listen to changes in DiffReviewStore to update UI
    diffReviewStore.onDidChangeDiffs((diffs) => {
      this.postMessage({
        type: 'updateDiffs',
        diffs: this.formatDiffsForWebview(diffs),
      });
    });

    // Listen to fallback events
    this.fallbackManager.onDidTriggerFallback((status) => {
      this.postMessage({
        type: 'fallbackStatus',
        status,
      });
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'submitPrompt':
          await this.handleUserPrompt(data.prompt);
          break;
        case 'cancel':
          this.cancelCurrentRun();
          break;
        case 'acceptHunk':
          diffReviewStore.acceptHunk(data.hunkId);
          break;
        case 'rejectHunk':
          diffReviewStore.rejectHunk(data.hunkId);
          break;
        case 'acceptAll':
          diffReviewStore.acceptAll();
          await diffApplier.applyApprovedHunks('Accepted all TrueForge changes');
          vscode.window.showInformationMessage('Applied all approved changes. (Undoable via Cmd+Z)');
          break;
        case 'rejectAll':
          diffReviewStore.rejectAll();
          diffReviewStore.clear();
          vscode.window.showInformationMessage('Rejected all proposed changes. Workspace files untouched.');
          break;
        case 'revertLast':
          await revertManager.revertLastEdit();
          break;
        case 'openFile':
          this.openWorkspaceFile(data.filePath);
          break;
        case 'openDiff':
          this.openDiffEditor(data.filePath);
          break;
        case 'testResilience':
          await this.runResilienceTest(data.mode);
          break;
      }
    });
  }

  public postMessage(message: any): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  public cancelCurrentRun(): void {
    this.wasCancelled = true;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.currentSessionId) {
      this.client.cancelSession(this.currentSessionId);
    }
    this.postMessage({
      type: 'status',
      status: 'Cancelled',
      message: 'Run stopped. Workspace files left completely unchanged.',
    });
    vscode.commands.executeCommand('setContext', 'trueforge.agentRunning', false);
  }

  private async handleUserPrompt(userPrompt: string): Promise<void> {
    if (!userPrompt || !userPrompt.trim()) {
      return;
    }

    this.wasCancelled = false;
    this.abortController = new AbortController();
    await vscode.commands.executeCommand('setContext', 'trueforge.agentRunning', true);

    this.postMessage({ type: 'startRun', prompt: userPrompt });
    this.postMessage({ type: 'status', status: 'Assembling Context', message: 'Analyzing workspace and budget...' });

    try {
      // 1. Context Assembly
      const assembled: AssembledContext = await contextRetriever.assembleContext(userPrompt);

      this.postMessage({
        type: 'contextAssembled',
        discoveredFiles: assembled.discoveredFiles,
        budgetReport: assembled.budgetReport,
      });

      this.postMessage({ type: 'status', status: 'Connecting', message: 'Connecting to TrueForge harness...' });

      // 2. Prepare instructions and prompt for TrueForge
      const fullPrompt = `${assembled.contextHeader}

User Goal:
${userPrompt}

Please proceed autonomously using the tools provided (read_file, file_search, grep_search, find_symbols, propose_edit, execute_command).
Discover all required files, plan the changes, propose the multi-file edits using propose_edit, and execute verification tests using execute_command.`;

      const cfg = getConfig();
      let activeModel = cfg.modelName;

      // 3. Create Session in TrueForge
      let session;
      try {
        session = await this.client.createSession({ name: cfg.agentName });
      } catch (namedErr) {
        session = await this.client.createSession({
          spec: {
            model: { name: activeModel },
            instructions: `You are an elite coding agent in VS Code.
Examine code thoroughly with read_file, file_search, and grep_search.
When proposing changes, call propose_edit with the exact file path and code replacement.
When running terminal commands or test suites, call execute_command.
Never write files directly to disk; always propose edits through propose_edit so the user can review hunks.`,
            mcpServers: [{ name: 'editor-tools' }],
            config: {
              iterationLimit: 50,
              contextManagement: {
                compaction: { enabled: true },
                largeToolResponse: { enabled: true },
              },
            },
          },
        });
      }

      this.currentSessionId = session.id;
      this.postMessage({ type: 'sessionCreated', sessionId: session.id, model: activeModel });
      this.postMessage({ type: 'status', status: 'Agent Running', message: 'TrueForge agent loop active...' });

      // 4. Stream turn events with automatic retry for transient 503 high demand spikes
      const isTransient503 = (msg: string) =>
        msg.includes('503') || msg.toLowerCase().includes('high demand') || msg.toLowerCase().includes('spikes in demand');

      let turnExecuted = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.streamTurnEvents(session.id, fullPrompt);
          turnExecuted = true;
          break;
        } catch (turnErr: any) {
          if (this.wasCancelled || this.abortController?.signal.aborted || turnErr?.name === 'AbortError') {
            throw turnErr;
          }
          if (attempt < 3 && isTransient503(turnErr?.message || '')) {
            this.postMessage({
              type: 'systemNote',
              text: `⚠️ Google Gemini experiencing high demand (503). Retrying in 2s (attempt ${attempt}/3)...`,
            });
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
          }
          throw turnErr;
        }
      }

      if (turnExecuted) {
        this.presentDiffReviewOrIdle();
      }
    } catch (err: any) {
      if (this.wasCancelled || this.abortController?.signal.aborted || err?.name === 'AbortError') {
        this.postMessage({ type: 'status', status: 'Cancelled', message: 'Agent run cancelled by user.' });
        return;
      }

      // Handle model fallback
      const fallbackModel = await this.fallbackManager.handleModelFailure(err);
      if (fallbackModel) {
        this.postMessage({
          type: 'status',
          status: 'Agent Running',
          message: `Retrying with TrueForge fallback model "${fallbackModel}"...`,
        });

        try {
          const session = await this.client.createSession({
            spec: {
              model: { name: fallbackModel },
              instructions: `You are the Ezra Coding Agent, an autonomous software engineering agent operating through the TrueForge harness in VS Code.
Examine code thoroughly with read_file, file_search, and grep_search.
When proposing changes, call propose_edit with the exact file path and code replacement.
When running terminal commands or test suites, call execute_command.
Never write files directly to disk; always propose edits through propose_edit so the user can review hunks.`,
              mcpServers: [{ name: 'editor-tools' }],
              config: {
                iterationLimit: 50,
                contextManagement: {
                  compaction: { enabled: true },
                  largeToolResponse: { enabled: true },
                },
              },
            },
          });
          this.currentSessionId = session.id;

          await this.streamTurnEvents(session.id, userPrompt);
          this.presentDiffReviewOrIdle();
        } catch (fallbackErr: any) {
          this.postMessage({
            type: 'status',
            status: 'Error',
            message: `Fallback model "${fallbackModel}" failed: ${fallbackErr?.message || fallbackErr}`,
          });
        }
      } else {
        this.postMessage({
          type: 'status',
          status: 'Error',
          message: `Execution failed: ${err?.message || err}`,
        });
      }
    } finally {
      await vscode.commands.executeCommand('setContext', 'trueforge.agentRunning', false);
      this.abortController = undefined;
      this.wasCancelled = false;
    }
  }

  private async streamTurnEvents(sessionId: string, prompt: string): Promise<void> {
    await this.client.createTurnStream(
      sessionId,
      prompt,
      async (event) => {
        if (this.abortController?.signal.aborted) {
          return;
        }

        if (event.type === 'turn.created') {
          // turn created
        } else if (event.type === 'model.message.delta') {
          const deltaEvent = event as ModelMessageDeltaEvent;
          if (deltaEvent.content) {
            this.postMessage({ type: 'textDelta', text: deltaEvent.content });
          }
          if (deltaEvent.toolCalls && deltaEvent.toolCalls.length > 0) {
            for (const tc of deltaEvent.toolCalls) {
              this.postMessage({
                type: 'toolCall',
                name: tc.function?.name || 'tool',
                args: tc.function?.arguments || '',
              });
            }
          }
        } else if (event.type === 'tool.approval_required') {
          const approvalEvent = event as ToolApprovalRequiredEvent;
          this.postMessage({
            type: 'approvalRequired',
            toolCalls: approvalEvent.toolCalls,
          });
        } else if (event.type === 'thread.context_compaction.started') {
          this.postMessage({
            type: 'systemNote',
            text: '⚡ TrueForge compaction started: compressing thread context to fit budget.',
          });
        } else if (event.type === 'thread.context_compaction.finished') {
          this.postMessage({
            type: 'systemNote',
            text: '✓ TrueForge compaction finished: context compacted successfully.',
          });
        } else if (event.type === 'tool.response_required') {
          this.postMessage({
            type: 'systemNote',
            text: '💬 Agent requires additional input or tool response.',
          });
        } else if (event.type === 'turn.update') {
          const anyEvent = event as any;
          if (anyEvent.state?.status === 'paused') {
            this.postMessage({
              type: 'status',
              status: 'Waiting',
              message: 'Agent paused and waiting for input.',
            });
          }
        } else if (event.type === 'thread.done') {
          const anyEvent = event as any;
          const content = anyEvent.state?.output?.content;
          if (content && typeof content === 'string') {
            this.postMessage({ type: 'textDelta', text: '\n\n' + content });
          }
        } else if (event.type === 'turn.done') {
          const anyEvent = event as any;
          if (anyEvent.state?.status !== 'error') {
            this.postMessage({ type: 'status', status: 'Turn Completed', message: 'Agent finished execution turn.' });
          }
        }
      },
      this.abortController?.signal
    );
  }

  private presentDiffReviewOrIdle(): void {
    const diffs = diffReviewStore.getDiffs();
    if (diffs.length > 0) {
      this.postMessage({
        type: 'status',
        status: 'Reviewing Diffs',
        message: `${diffs.length} file(s) proposed for review.`,
      });
    } else {
      this.postMessage({
        type: 'status',
        status: 'Idle',
        message: 'Task complete. No diffs proposed.',
      });
    }
  }

  private async openWorkspaceFile(relPath: string): Promise<void> {
    const roots = vscode.workspace.workspaceFolders;
    if (!roots || roots.length === 0) return;
    const fileUri = vscode.Uri.file(path.resolve(roots[0].uri.fsPath, relPath));
    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc);
  }

  private async openDiffEditor(relPath: string): Promise<void> {
    const fileDiff = diffReviewStore.getDiff(relPath);
    if (!fileDiff) return;

    const originalUri = vscode.Uri.file(fileDiff.absolutePath);
    const proposedUri = vscode.Uri.parse(`untitled:${fileDiff.filePath}.proposed`);

    const edit = new vscode.WorkspaceEdit();
    edit.insert(proposedUri, new vscode.Position(0, 0), fileDiff.proposedContent);
    await vscode.workspace.applyEdit(edit);

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      `${path.basename(fileDiff.filePath)} (Proposed Diff)`
    );
  }

  private async runResilienceTest(mode: 'unreachable' | 'invalid_key'): Promise<void> {
    this.postMessage({
      type: 'status',
      status: 'Testing Resilience',
      message: `Executing Resilience Task C (${mode === 'unreachable' ? 'Unreachable Endpoint' : 'Invalid API Key'})...`,
    });

    const badClient = new TrueForgeClient({
      baseUrl: mode === 'unreachable' ? 'http://127.0.0.1:9999' : this.client.getBaseUrl(),
      token: mode === 'invalid_key' ? 'invalid-key-xyz' : undefined,
      timeoutMs: 3000,
    });

    const fallbackMgr = new ModelFallbackManager(badClient);

    try {
      await badClient.createSession({
        spec: {
          model: { name: 'invalid-model' },
        },
      });
    } catch (err: any) {
      const fallbackResult = await fallbackMgr.handleModelFailure(err);
      this.postMessage({
        type: 'resilienceResult',
        success: true,
        testedMode: mode,
        errorObserved: err?.message || String(err),
        fallbackModel: fallbackResult,
        statusMessage: fallbackResult
          ? `Successfully recovered and fell back to TrueForge model "${fallbackResult}".`
          : `Handled gracefully: honest error displayed, workspace files and git status remain completely untouched.`,
      });
    }
  }

  private formatDiffsForWebview(diffs: FileDiff[]): any[] {
    return diffs.map((d) => ({
      filePath: d.filePath,
      status: d.status,
      hunkCount: d.hunks.length,
      hunks: d.hunks.map((h) => ({
        id: h.id,
        filePath: h.filePath,
        header: h.header,
        oldLines: h.oldContent.split('\n'),
        newLines: h.newContent.split('\n'),
        status: h.status,
      })),
    }));
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TrueForge Agent</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-sideBar-background);
      --border: var(--vscode-panel-border, #333);
      --accent: var(--vscode-button-background, #007acc);
      --accent-fg: var(--vscode-button-foreground, #fff);
      --added-bg: rgba(46, 160, 67, 0.15);
      --added-fg: #3fb950;
      --removed-bg: rgba(248, 81, 73, 0.15);
      --removed-fg: #f85149;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background-color: var(--bg);
      margin: 0;
      padding: 12px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 8px;
    }
    .badge {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--card-bg);
      border: 1px solid var(--border);
    }
    .badge.running {
      background: #02569b;
      color: #fff;
    }
    .badge.review {
      background: #b26a00;
      color: #fff;
    }
    .badge.error {
      background: #c62828;
      color: #fff;
    }
    .chat-container {
      flex: 1;
      overflow-y: auto;
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .message {
      padding: 8px 12px;
      border-radius: 6px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message.user {
      border-left: 3px solid var(--accent);
    }
    .message.assistant {
      border-left: 3px solid #3fb950;
    }
    .message.system {
      border-left: 3px solid #e3b341;
      font-size: 11px;
      opacity: 0.9;
    }
    .tool-event {
      font-size: 11px;
      background: rgba(255, 255, 255, 0.05);
      padding: 4px 8px;
      border-radius: 4px;
      border-left: 3px solid #8957e5;
      font-family: monospace;
    }
    .context-box {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      font-size: 11px;
    }
    .context-header {
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .meter {
      height: 6px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 4px;
    }
    .meter-fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      transition: width 0.3s;
    }
    .diff-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-top: 8px;
      padding: 8px;
    }
    .diff-card-header {
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      margin-bottom: 6px;
    }
    .hunk-view {
      border: 1px solid var(--border);
      border-radius: 4px;
      margin-top: 6px;
      overflow: hidden;
      font-family: monospace;
      font-size: 11px;
    }
    .hunk-header {
      background: rgba(255, 255, 255, 0.05);
      padding: 4px 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .line-added {
      background: var(--added-bg);
      color: var(--added-fg);
      padding: 1px 4px;
    }
    .line-removed {
      background: var(--removed-bg);
      color: var(--removed-fg);
      padding: 1px 4px;
    }
    .hunk-actions {
      display: flex;
      gap: 4px;
    }
    button {
      background: var(--accent);
      color: var(--accent-fg);
      border: none;
      padding: 4px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    }
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }
    button.danger {
      background: #c62828;
      color: #fff;
    }
    button.success {
      background: #2ea44f;
      color: #fff;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .input-row {
      display: flex;
      gap: 6px;
    }
    textarea {
      flex: 1;
      height: 60px;
      background: var(--card-bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px;
      resize: vertical;
      font-family: inherit;
    }
    .actions-bar {
      display: flex;
      gap: 6px;
      margin-top: 6px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div><strong>TrueForge</strong> <span id="statusBadge" class="badge">Idle</span></div>
    <div>
      <button id="cancelBtn" class="danger" style="display:none;" onclick="cancelRun()">Stop Run</button>
      <button class="secondary" onclick="revertLast()">Revert Edit</button>
    </div>
  </div>

  <div id="contextBox" class="context-box" style="display:none;">
    <div class="context-header">
      <span>Context Assembly</span>
      <span id="budgetMeterLabel">0 / 16,000 tokens</span>
    </div>
    <div class="meter"><div id="meterFill" class="meter-fill"></div></div>
    <div id="filesList" style="margin-top:4px;"></div>
  </div>

  <div id="chatContainer" class="chat-container">
    <div class="message system">TrueForge Coding Agent ready. Use @file or @symbol mentions, or enter repository goals. All changes are staged for your review before touching disk.</div>
  </div>

  <div id="diffReviewContainer" style="display:none;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
      <strong>Proposed Diff Review</strong>
      <div>
        <button class="success" onclick="acceptAll()">Accept All</button>
        <button class="danger" onclick="rejectAll()">Reject All</button>
      </div>
    </div>
    <div id="diffCards"></div>
  </div>

  <div class="input-area">
    <div class="input-row">
      <textarea id="promptInput" placeholder="Enter request (e.g. Add flask config CLI command, mask secrets as ***)..."></textarea>
    </div>
    <div class="actions-bar">
      <button id="submitBtn" onclick="submitPrompt()" style="flex:1;">Send to TrueForge</button>
      <button class="secondary" title="Test Resilience / Fallback" onclick="testResilience('unreachable')">Test Resilience</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentAssistantMsg = null;

    function submitPrompt() {
      const input = document.getElementById('promptInput');
      const text = input.value.trim();
      if (!text) return;

      appendMessage('user', text);
      input.value = '';
      vscode.postMessage({ type: 'submitPrompt', prompt: text });
      document.getElementById('cancelBtn').style.display = 'inline-block';
    }

    function cancelRun() {
      vscode.postMessage({ type: 'cancel' });
      document.getElementById('cancelBtn').style.display = 'none';
    }

    function acceptAll() {
      vscode.postMessage({ type: 'acceptAll' });
    }

    function rejectAll() {
      vscode.postMessage({ type: 'rejectAll' });
    }

    function revertLast() {
      vscode.postMessage({ type: 'revertLast' });
    }

    function testResilience(mode) {
      vscode.postMessage({ type: 'testResilience', mode });
    }

    function acceptHunk(hunkId) {
      vscode.postMessage({ type: 'acceptHunk', hunkId });
    }

    function rejectHunk(hunkId) {
      vscode.postMessage({ type: 'rejectHunk', hunkId });
    }

    function openDiff(filePath) {
      vscode.postMessage({ type: 'openDiff', filePath });
    }

    function appendMessage(role, text) {
      const chat = document.getElementById('chatContainer');
      const msg = document.createElement('div');
      msg.className = 'message ' + role;
      msg.textContent = text;
      chat.appendChild(msg);
      chat.scrollTop = chat.scrollHeight;
      return msg;
    }

    window.addEventListener('message', event => {
      const data = event.data;
      switch (data.type) {
        case 'startRun':
          currentAssistantMsg = null;
          break;
        case 'status':
          const badge = document.getElementById('statusBadge');
          badge.textContent = data.status;
          badge.className = 'badge ' + (data.status.toLowerCase().includes('run') ? 'running' : data.status.toLowerCase().includes('diff') ? 'review' : '');
          const isDone = data.status === 'Idle' || data.status === 'Cancelled' || data.status === 'Error' || data.status === 'Turn Completed' || data.status === 'Completed' || data.status === 'Reviewing Diffs';
          if (isDone) {
            document.getElementById('cancelBtn').style.display = 'none';
            document.getElementById('sendBtn').disabled = false;
            document.getElementById('promptInput').disabled = false;
          } else if (data.status.toLowerCase().includes('run') || data.status === 'Connecting' || data.status === 'Assembling Context') {
            document.getElementById('cancelBtn').style.display = 'inline-block';
            document.getElementById('sendBtn').disabled = true;
          }
          if (data.message) {
            appendMessage('system', data.message);
          }
          break;
        case 'textDelta':
          if (!currentAssistantMsg) {
            currentAssistantMsg = appendMessage('assistant', '');
          }
          currentAssistantMsg.textContent += data.text;
          document.getElementById('chatContainer').scrollTop = document.getElementById('chatContainer').scrollHeight;
          break;
        case 'toolCall':
          appendMessage('system', '⚙️ Tool Call: ' + data.name + ' (' + (data.args ? data.args.substring(0, 100) : '') + ')');
          break;
        case 'systemNote':
          appendMessage('system', data.text);
          break;
        case 'fallbackStatus':
          if (data.status.warning) {
            appendMessage('system', '⚠️ ' + data.status.warning);
          }
          break;
        case 'contextAssembled':
          const box = document.getElementById('contextBox');
          box.style.display = 'block';
          const rep = data.budgetReport;
          document.getElementById('budgetMeterLabel').textContent = rep.usedTokens + ' / ' + rep.maxTokens + ' tokens (' + rep.budgetPercentage + '%)';
          document.getElementById('meterFill').style.width = rep.budgetPercentage + '%';
          const filesDiv = document.getElementById('filesList');
          filesDiv.innerHTML = '<strong>Discovered:</strong> ' + data.discoveredFiles.map(f => f.filePath + ' (' + f.reason + ')').join(', ');
          break;
        case 'updateDiffs':
          renderDiffs(data.diffs);
          break;
        case 'resilienceResult':
          appendMessage('system', '🛡️ Resilience Test Result: ' + data.statusMessage + ' (Observed: ' + data.errorObserved + ')');
          break;
      }
    });

    function renderDiffs(diffs) {
      const container = document.getElementById('diffReviewContainer');
      const cardsDiv = document.getElementById('diffCards');
      if (!diffs || diffs.length === 0) {
        container.style.display = 'none';
        cardsDiv.innerHTML = '';
        return;
      }
      container.style.display = 'block';
      cardsDiv.innerHTML = '';

      diffs.forEach(d => {
        const card = document.createElement('div');
        card.className = 'diff-card';
        card.innerHTML = '<div class="diff-card-header">' +
          '<span>' + d.filePath + ' (' + d.hunkCount + ' hunks) - ' + d.status + '</span>' +
          '<button class="secondary" onclick="openDiff(\\'' + d.filePath + '\\')">Open Diff</button>' +
          '</div>';

        d.hunks.forEach(h => {
          const hunkDiv = document.createElement('div');
          hunkDiv.className = 'hunk-view';
          hunkDiv.innerHTML = '<div class="hunk-header">' +
            '<span>' + h.header + ' [' + h.status + ']</span>' +
            '<div class="hunk-actions">' +
            (h.status !== 'accepted' ? '<button class="success" onclick="acceptHunk(\\'' + h.id + '\\')">Accept</button>' : '') +
            (h.status !== 'rejected' ? '<button class="danger" onclick="rejectHunk(\\'' + h.id + '\\')">Reject</button>' : '') +
            '</div>' +
            '</div>' +
            '<div style="max-height:120px; overflow-y:auto;">' +
            h.oldLines.map(l => '<div class="line-removed">- ' + escapeHtml(l) + '</div>').join('') +
            h.newLines.map(l => '<div class="line-added">+ ' + escapeHtml(l) + '</div>').join('') +
            '</div>';
          card.appendChild(hunkDiv);
        });

        cardsDiv.appendChild(card);
      });
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }
}
