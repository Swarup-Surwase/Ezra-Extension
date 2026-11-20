import * as vscode from 'vscode';

export interface TrueForgeConfig {
  serverUrl: string;
  agentName: string;
  modelName: string;
  fallbackModelName: string;
  contextBudgetTokens: number;
  maxDiscoveredFiles: number;
  enableMcpTools: boolean;
  commandTimeoutMs: number;
}

export function getConfig(): TrueForgeConfig {
  const cfg = vscode.workspace.getConfiguration('trueforge');
  return {
    serverUrl: cfg.get<string>('serverUrl', 'http://localhost:8790').replace(/\/+$/, ''),
    agentName: cfg.get<string>('agentName', 'ezra-code-agent'),
    modelName: cfg.get<string>('modelName', 'google-gemini/gemini-3-1-flash-lite'),
    fallbackModelName: cfg.get<string>('fallbackModelName', 'google-gemini/gemini-3-flash-preview'),
    contextBudgetTokens: cfg.get<number>('contextBudgetTokens', 16000),
    maxDiscoveredFiles: cfg.get<number>('maxDiscoveredFiles', 15),
    enableMcpTools: cfg.get<boolean>('enableMcpTools', true),
    commandTimeoutMs: cfg.get<number>('commandTimeoutMs', 30000),
  };
}

