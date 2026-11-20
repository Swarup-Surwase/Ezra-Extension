import {
  AgentSpec,
  AvailableModelsResponse,
  CreateSessionRequest,
  CreateTurnEventRequest,
  CreateTurnRequest,
  SessionResponse,
  TurnStreamingEvent,
  TurnUserEvent,
} from './types';
import { SSEStreamParser } from './SSEStream';
import { withRetry } from './retry';

export interface TrueForgeClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

export class TrueForgeClient {
  private baseUrl: string;
  private token?: string;
  private timeoutMs: number;

  constructor(options: TrueForgeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '');
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  private getHeaders(additionalHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      ...additionalHeaders,
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  public async checkHealth(): Promise<boolean> {
    try {
      const res = await this.rawRequest('GET', '/api/v1/agents', undefined, undefined, 5000);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  public async listConfiguredModels(): Promise<string[]> {
    return withRetry(async () => {
      const res = await this.rawRequest('GET', '/api/v1/models');
      if (res.status !== 200) {
        throw new Error(`Failed to list models: HTTP ${res.status} ${res.body}`);
      }
      if (!res.body || !res.body.trim()) {
        return [];
      }
      const data = JSON.parse(res.body) as AvailableModelsResponse;
      return (data.data || []).map((m) => m.name || m.model_id);
    });
  }

  public async listCatalogModels(): Promise<Array<{ type: string; models: string[] }>> {
    return withRetry(async () => {
      const res = await this.rawRequest('GET', '/api/v1/catalogs/model-providers');
      if (res.status !== 200) {
        return [];
      }
      if (!res.body || !res.body.trim()) {
        return [];
      }
      const parsed = JSON.parse(res.body);
      const providers = parsed.data || [];
      return providers.map((p: any) => ({
        type: p.type,
        models: (p.models || []).map((m: any) => m.name || m.model_id),
      }));
    });
  }

  public async registerModelProvider(manifest: Record<string, unknown>): Promise<void> {
    const res = await this.rawRequest('PUT', '/api/v1/settings/model-providers', { manifest });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`Failed to configure model provider: HTTP ${res.status} ${res.body}`);
    }
  }

  public async registerMcpServer(name: string, url: string, description: string): Promise<void> {
    const manifest = {
      name,
      type: 'remote',
      url,
      description,
    };
    const res = await this.rawRequest('PUT', '/api/v1/settings/mcp-servers', { manifest });
    if (res.status !== 200 && res.status !== 201) {
      console.warn(`[TrueForgeClient] Register MCP server returned status ${res.status}: ${res.body}`);
    }
  }

  public async createSession(agent: { name: string } | { spec: AgentSpec }): Promise<SessionResponse> {
    return withRetry(async () => {
      let wireAgent: any = agent;
      if ('spec' in agent && agent.spec) {
        const s: any = agent.spec;
        wireAgent = {
          spec: {
            model: s.model,
            ...(s.instructions ? { instructions: s.instructions } : {}),
            ...((s.mcp_servers || s.mcpServers) ? { mcp_servers: s.mcp_servers || s.mcpServers } : {}),
            ...(s.skills ? { skills: s.skills } : {}),
            ...(s.config ? {
              config: {
                ...(s.config.iteration_limit ?? s.config.iterationLimit ? { iteration_limit: s.config.iteration_limit ?? s.config.iterationLimit } : {}),
                ...(s.config.context_management || s.config.contextManagement ? {
                  context_management: {
                    compaction: (s.config.context_management?.compaction ?? s.config.contextManagement?.compaction) || { enabled: true },
                    large_tool_response: (s.config.context_management?.large_tool_response ?? s.config.contextManagement?.largeToolResponse) || { enabled: true },
                  },
                } : {}),
              },
            } : {}),
          },
        };
      }
      const reqBody: any = { agent: wireAgent };
      const res = await this.rawRequest('POST', '/api/v1/sessions', reqBody);
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(`Failed to create session in TrueForge: HTTP ${res.status} - ${res.body}`);
      }
      if (!res.body || !res.body.trim()) {
        throw new Error(`TrueForge returned an empty session response (HTTP ${res.status})`);
      }
      let data: any;
      try {
        data = JSON.parse(res.body);
      } catch (parseErr: any) {
        throw new Error(`Failed to parse session JSON from TrueForge (HTTP ${res.status}): ${res.body}`);
      }
      return data.data || data;
    });
  }

  public async cancelSession(sessionId: string): Promise<void> {
    try {
      await this.rawRequest('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/cancel`);
    } catch (e) {
      console.warn('[TrueForgeClient] Cancel session warning:', e);
    }
  }

  public async createTurnStream(
    sessionId: string,
    prompt: string,
    onEvent: (event: TurnStreamingEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const reqBody: CreateTurnRequest = {
      input: [{ type: 'user.message', content: prompt }],
    };

    const targetUrl = `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`;
    const postData = JSON.stringify(reqBody);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: this.getHeaders({
          Accept: 'text/event-stream',
        }),
        body: postData,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`TrueForge turn creation failed (HTTP ${res.status}): ${errorBody}`);
      }

      if (!res.body) {
        throw new Error('TrueForge turn response body is null');
      }

      const parser = new SSEStreamParser();
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');

      let turnError: string | undefined;
      const handleEvent = (event: TurnStreamingEvent) => {
        if (event.type === 'turn.done') {
          const anyEvent = event as any;
          if (anyEvent.state?.status === 'error') {
            turnError = anyEvent.state?.message || 'Model execution encountered an error.';
          }
        }
        onEvent(event);
      };

      while (true) {
        if (signal?.aborted) {
          break;
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          parser.parseChunk(chunk, handleEvent);
        }
      }

      parser.flush(handleEvent);

      if (turnError && !signal?.aborted) {
        throw new Error(turnError);
      }
    } catch (err: any) {
      if (signal?.aborted) {
        return;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async sendTurnEvents(
    sessionId: string,
    turnId: string,
    events: TurnUserEvent[]
  ): Promise<void> {
    const reqBody: CreateTurnEventRequest = { events };
    const res = await this.rawRequest(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`,
      reqBody
    );
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`Failed to send turn event: HTTP ${res.status} - ${res.body}`);
    }
  }

  private async rawRequest(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    timeoutMs?: number
  ): Promise<{ status: number; body: string }> {
    const targetUrl = `${this.baseUrl}${path}`;
    const postData = body ? JSON.stringify(body) : undefined;
    const reqHeaders = this.getHeaders(headers);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);

    try {
      const res = await fetch(targetUrl, {
        method,
        headers: reqHeaders,
        body: postData,
        signal: controller.signal,
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
