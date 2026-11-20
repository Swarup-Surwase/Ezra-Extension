import * as vscode from 'vscode';
import * as path from 'path';
import { getWorkspaceRoots } from './pathSafety';

export interface FindSymbolsInput {
  query: string;
  maxResults?: number;
}

export interface SymbolItem {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  containerName?: string;
}

export interface FindSymbolsResult {
  query: string;
  symbols: SymbolItem[];
  totalFound: number;
}

const SYMBOL_KINDS: Record<number, string> = {
  [vscode.SymbolKind.File]: 'File',
  [vscode.SymbolKind.Module]: 'Module',
  [vscode.SymbolKind.Namespace]: 'Namespace',
  [vscode.SymbolKind.Package]: 'Package',
  [vscode.SymbolKind.Class]: 'Class',
  [vscode.SymbolKind.Method]: 'Method',
  [vscode.SymbolKind.Property]: 'Property',
  [vscode.SymbolKind.Field]: 'Field',
  [vscode.SymbolKind.Constructor]: 'Constructor',
  [vscode.SymbolKind.Enum]: 'Enum',
  [vscode.SymbolKind.Interface]: 'Interface',
  [vscode.SymbolKind.Function]: 'Function',
  [vscode.SymbolKind.Variable]: 'Variable',
  [vscode.SymbolKind.Constant]: 'Constant',
  [vscode.SymbolKind.String]: 'String',
  [vscode.SymbolKind.Number]: 'Number',
  [vscode.SymbolKind.Boolean]: 'Boolean',
  [vscode.SymbolKind.Array]: 'Array',
  [vscode.SymbolKind.Object]: 'Object',
  [vscode.SymbolKind.Key]: 'Key',
  [vscode.SymbolKind.Null]: 'Null',
  [vscode.SymbolKind.EnumMember]: 'EnumMember',
  [vscode.SymbolKind.Struct]: 'Struct',
  [vscode.SymbolKind.Event]: 'Event',
  [vscode.SymbolKind.Operator]: 'Operator',
  [vscode.SymbolKind.TypeParameter]: 'TypeParameter',
};

export async function findSymbolsTool(input: FindSymbolsInput): Promise<FindSymbolsResult> {
  const query = (input.query || '').trim();
  const maxResults = input.maxResults ?? 20;
  const roots = getWorkspaceRoots();

  let symbols: vscode.SymbolInformation[] = [];
  try {
    const res = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      query
    );
    if (res && Array.isArray(res)) {
      symbols = res;
    }
  } catch (e) {
    console.warn('[FindSymbols] executeWorkspaceSymbolProvider error:', e);
  }

  const items: SymbolItem[] = [];
  for (const s of symbols.slice(0, maxResults)) {
    let relPath = s.location.uri.fsPath;
    for (const r of roots) {
      if (s.location.uri.fsPath.startsWith(r)) {
        relPath = path.relative(r, s.location.uri.fsPath);
        break;
      }
    }

    items.push({
      name: s.name,
      kind: SYMBOL_KINDS[s.kind] || 'Unknown',
      filePath: relPath,
      line: s.location.range.start.line + 1,
      containerName: s.containerName,
    });
  }

  return {
    query,
    symbols: items,
    totalFound: items.length,
  };
}

