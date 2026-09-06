import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
export type TextPart = { type: 'text'; text: string }
export type ImagePart = {
  type: 'image_url'
  image_url: { url: string; detail: 'high' }
}
export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | Array<TextPart | ImagePart>
  tool_call_id?: string
  tool_calls?: ToolCall[]
}
export type ModelTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}
export type ProviderConfig = {
  baseUrl: string
  apiKey: string
  model: string
  reasoningEffort: 'high'
  maxOutputTokens: number
  timeoutMs: number
}
export type ModelResponse = {
  id: string
  model: string
  message: ChatMessage
  finishReason: string
  usage: Record<string, unknown>
}
export type ModelRequest = {
  messages: ChatMessage[]
  tools: ModelTool[]
  signal?: AbortSignal
}
export type Complete = (request: ModelRequest) => Promise<ModelResponse>

export type ToolExecution = {
  result: CallToolResult
  completion?: Record<string, unknown>
  terminal?: string
}
export type AgentOptions = {
  complete: Complete
  tools: ModelTool[]
  messages: ChatMessage[]
  execute: (
    name: string,
    args: Record<string, unknown>,
    step: number,
  ) => Promise<ToolExecution>
  record: (event: Record<string, unknown>) => Promise<void>
  maxSteps: number
  contextWindow: number
  maxOutputTokens: number
  signal?: AbortSignal
}
export type AgentResult = {
  status: 'completed' | 'incomplete'
  reason: string
  steps: number
  completion?: Record<string, unknown>
  usage: Array<Record<string, unknown>>
}
