export interface ModelRef {
  name: string;
  params?: Record<string, unknown>;
}

export interface McpServerRef {
  name: string;
}

export interface SkillRef {
  name: string;
}

export interface RuntimeConfig {
  iterationLimit?: number;
  contextManagement?: {
    compaction?: { enabled?: boolean; thresholdTokens?: number };
    largeToolResponse?: { enabled?: boolean; maxBytes?: number };
  };
  sandbox?: {
    enabled?: boolean;
    provider?: string;
  };
}

export interface AgentSpec {
  model: ModelRef;
  instructions?: string;
  mcpServers?: McpServerRef[];
  skills?: SkillRef[];
  config?: RuntimeConfig;
}

export interface CreateSessionRequest {
  agent: { name: string } | { spec: AgentSpec };
  metadata?: Record<string, unknown>;
}

export interface SessionResponse {
  id: string;
  agent?: {
    name?: string;
    spec?: AgentSpec;
  };
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface UserMessageInput {
  type: 'user.message';
  content: string;
}

export interface CreateTurnRequest {
  input: UserMessageInput[];
  previousTurnId?: string;
}

export interface ToolCallRef {
  id: string;
  sourceEventId?: string;
}

export interface ToolCallPayload {
  id: string;
  type?: 'function';
  function?: {
    name: string;
    arguments: string;
  };
}

export interface ModelMessageDeltaEvent {
  type: 'model.message.delta';
  id: string;
  threadId: string;
  content?: string | null;
  reasoningContent?: string;
  toolCalls?: ToolCallPayload[];
  finishReason?: string | null;
  createdAt?: string;
}

export interface ToolApprovalRequiredEvent {
  type: 'tool.approval_required';
  id: string;
  threadId: string;
  toolCalls: ToolCallRef[];
  createdAt: string;
}

export interface ToolResponseRequiredEvent {
  type: 'tool.response_required';
  id: string;
  threadId: string;
  toolCalls: ToolCallRef[];
  createdAt: string;
}

export interface TurnCreatedEvent {
  type: 'turn.created';
  id: string;
  threadId?: string;
  createdAt: string;
}

export interface TurnDoneEvent {
  type: 'turn.done';
  id: string;
  status?: string;
  createdAt: string;
}

export interface CompactionStartedEvent {
  type: 'thread.context_compaction.started';
  threadId: string;
  createdAt: string;
}

export interface CompactionFinishedEvent {
  type: 'thread.context_compaction.finished';
  threadId: string;
  tokensReclaimed?: number;
  createdAt: string;
}

export type TurnStreamingEvent =
  | ModelMessageDeltaEvent
  | ToolApprovalRequiredEvent
  | ToolResponseRequiredEvent
  | TurnCreatedEvent
  | TurnDoneEvent
  | CompactionStartedEvent
  | CompactionFinishedEvent
  | { type: string; [key: string]: unknown };

export interface UserToolApprovalEvent {
  type: 'user.tool_approval';
  toolCallId: string;
  threadId: string;
  approval: { status: 'allow' } | { status: 'deny'; reason?: string };
}

export interface UserToolResponseEvent {
  type: 'user.tool_response';
  toolCallId: string;
  threadId: string;
  content: string;
}

export type TurnUserEvent = UserToolApprovalEvent | UserToolResponseEvent;

export interface CreateTurnEventRequest {
  events: TurnUserEvent[];
}

export interface ConfiguredModelItem {
  model_id: string;
  name: string;
  properties?: {
    context_length?: number;
    max_output_tokens?: number;
  };
}

export interface AvailableModelsResponse {
  data: ConfiguredModelItem[];
}

