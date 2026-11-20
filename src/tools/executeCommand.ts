import * as vscode from 'vscode';
import { exec } from 'child_process';
import { getWorkspaceRoots, resolveSafeWorkspacePath } from './pathSafety';
import { getConfig } from '../config';

export interface ExecuteCommandInput {
  command: string;
  cwd?: string;
  explanation?: string;
}

export interface ExecuteCommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  approved: boolean;
}

export async function executeCommandTool(input: ExecuteCommandInput): Promise<ExecuteCommandResult> {
  const command = (input.command || '').trim();
  if (!command) {
    throw new Error('execute_command: command cannot be empty.');
  }

  const roots = getWorkspaceRoots();
  const cwd = input.cwd ? resolveSafeWorkspacePath(input.cwd) : roots[0];

  const cfg = getConfig();
  const timeoutMs = cfg.commandTimeoutMs || 30000;

  // Explicit user approval dialog in VS Code UI
  const explanation = input.explanation ? `\nPurpose: ${input.explanation}` : '';
  const promptMessage = `TrueForge Agent requests to run terminal command:\n\`${command}\`\nWorking directory: ${cwd}${explanation}`;

  const selection = await vscode.window.showWarningMessage(
    promptMessage,
    { modal: true },
    'Approve & Run',
    'Deny'
  );

  if (selection !== 'Approve & Run') {
    return {
      command,
      cwd,
      exitCode: 1,
      stdout: '',
      stderr: 'Command execution was denied by the user in VS Code.',
      approved: false,
    };
  }

  // Execute approved command with timeout
  return new Promise<ExecuteCommandResult>((resolve) => {
    exec(command, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        command,
        cwd,
        exitCode: error ? (error.code ?? 1) : 0,
        stdout: stdout || '',
        stderr: stderr || (error ? error.message : ''),
        approved: true,
      });
    });
  });
}

