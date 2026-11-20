import * as http from 'http';
import { readFileTool } from '../tools/readFile';
import { fileSearchTool } from '../tools/fileSearch';
import { grepSearchTool } from '../tools/grepSearch';
import { findSymbolsTool } from '../tools/findSymbols';
import { proposeEditTool } from '../tools/proposeEdit';
import { executeCommandTool } from '../tools/executeCommand';

export class EditorMcpServer {
  private server?: http.Server;
  private port = 8920;
  private isRunning = false;

  public async start(preferredPort = 8920): Promise<number> {
    if (this.isRunning && this.server) {
      return this.port;
    }

    this.port = preferredPort;

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-tfg-mcp-headers');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = req.url || '';

        // Health check endpoint
        if (req.method === 'GET' && (url === '/' || url === '/health')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', server: 'editor-tools' }));
          return;
        }

        // SSE endpoint for streaming MCP transports
        if (req.method === 'GET' && url.startsWith('/mcp/sse')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`event: endpoint\ndata: /mcp/message\n\n`);
          return;
        }

        // JSON-RPC endpoint: POST /mcp or POST /mcp/message
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', async () => {
            try {
              const rpc = JSON.parse(body || '{}');
              const response = await this.handleJsonRpc(rpc);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(response));
            } catch (err: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: null,
                  error: { code: -32603, message: err?.message || 'Internal RPC error' },
                })
              );
            }
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          // Retry with port + 1
          this.port++;
          this.server?.close();
          this.server?.listen(this.port, '127.0.0.1');
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.isRunning = true;
        resolve(this.port);
      });
    });
  }

  public getEndpointUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.isRunning = false;
    }
  }

  public async handleToolCall(name: string, args: Record<string, any>): Promise<any> {
    switch (name) {
      case 'read_file':
        return readFileTool({
          filePath: args.filePath || args.path || args.file,
          startLine: args.startLine,
          endLine: args.endLine,
        });

      case 'file_search':
        return await fileSearchTool({
          query: args.query || args.pattern,
          maxResults: args.maxResults,
        });

      case 'grep_search':
        return await grepSearchTool({
          query: args.query || args.pattern,
          filePattern: args.filePattern,
          caseSensitive: args.caseSensitive,
          maxMatches: args.maxMatches,
        });

      case 'find_symbols':
        return await findSymbolsTool({
          query: args.query || args.name,
          maxResults: args.maxResults,
        });

      case 'propose_edit':
        return proposeEditTool({
          filePath: args.filePath || args.path || args.file,
          proposedContent: args.proposedContent,
          oldStr: args.oldStr,
          newStr: args.newStr,
          unifiedDiff: args.unifiedDiff || args.diff,
          explanation: args.explanation,
        });

      case 'execute_command':
        return await executeCommandTool({
          command: args.command || args.cmd,
          cwd: args.cwd,
          explanation: args.explanation,
        });

      default:
        throw new Error(`Unknown tool "${name}". Available tools: read_file, file_search, grep_search, find_symbols, propose_edit, execute_command.`);
    }
  }

  private async handleJsonRpc(rpc: any): Promise<any> {
    const { id, method, params } = rpc;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: {
            name: 'editor-tools',
            version: '1.0.0',
          },
          capabilities: {
            tools: {},
          },
        },
      };
    }

    if (method === 'notifications/initialized') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: this.getToolDefinitions(),
        },
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      try {
        const toolResult = await this.handleToolCall(toolName, toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2),
              },
            ],
          },
        };
      } catch (err: any) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Tool execution error: ${err?.message || String(err)}`,
              },
            ],
          },
        };
      }
    }

    // Default method not found
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  private getToolDefinitions(): any[] {
    return [
      {
        name: 'read_file',
        description: 'Read the contents of a text file in the workspace within safety boundaries. Optionally specify startLine and endLine.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Relative path of the workspace file to read.' },
            startLine: { type: 'number', description: '1-based starting line number (optional).' },
            endLine: { type: 'number', description: '1-based ending line number (optional).' },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'file_search',
        description: 'Search for files in the active workspace matching a filename query or pattern.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Filename query or glob pattern (e.g. "helpers.py" or "*cli*").' },
            maxResults: { type: 'number', description: 'Maximum number of results to return (default 50).' },
          },
        },
      },
      {
        name: 'grep_search',
        description: 'Search file contents across the workspace for matching text or regex.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text or regex to search for.' },
            filePattern: { type: 'string', description: 'Glob pattern for filtering files (e.g. "**/*.py").' },
            caseSensitive: { type: 'boolean', description: 'Whether search is case-sensitive (default false).' },
          },
          required: ['query'],
        },
      },
      {
        name: 'find_symbols',
        description: 'Search for workspace symbols (functions, classes, methods, variables).',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Symbol name to search for (e.g. "get_debug_flag").' },
          },
          required: ['query'],
        },
      },
      {
        name: 'propose_edit',
        description: 'Propose a code modification to a workspace file. All changes are staged for hunk-by-hunk user review in VS Code. Never touches files on disk before approval.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Relative workspace file path to modify.' },
            proposedContent: { type: 'string', description: 'Complete proposed new content for the file.' },
            oldStr: { type: 'string', description: 'Exact string in the original file to replace.' },
            newStr: { type: 'string', description: 'Replacement string.' },
            explanation: { type: 'string', description: 'Brief explanation of why this change is being made.' },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'execute_command',
        description: 'Request execution of a terminal command in the workspace. Requires explicit user approval in VS Code before executing.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The exact command line string to execute.' },
            cwd: { type: 'string', description: 'Optional working directory relative to workspace root.' },
            explanation: { type: 'string', description: 'Brief explanation shown to the user explaining why this command is needed.' },
          },
          required: ['command'],
        },
      },
    ];
  }
}

export const editorMcpServer = new EditorMcpServer();

