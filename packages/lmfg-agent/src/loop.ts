import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { ProviderResponseError } from './provider.js'
import type {
  AgentOptions,
  AgentResult,
  ChatMessage,
  ImagePart,
  TextPart,
  ToolExecution,
} from './types.js'

function estimatedTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += 12
    if (Array.isArray(message.content)) {
      total += message.content.reduce(
        (sum, part) =>
          sum +
          (part.type === 'image_url' ? 4096 : Math.ceil(part.text.length / 3)),
        0,
      )
    } else total += Math.ceil((message.content?.length ?? 0) / 3)
    if (message.tool_calls)
      total += Math.ceil(JSON.stringify(message.tool_calls).length / 3)
  }
  return total
}

function failure(message: string): ToolExecution {
  return {
    result: {
      isError: true,
      content: [
        { type: 'text', text: JSON.stringify({ ok: false, error: message }) },
      ],
    },
  }
}

function toolText(result: CallToolResult): string {
  return (
    result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n') || JSON.stringify({ ok: !result.isError })
  )
}

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const messages = structuredClone(options.messages)
  const names = new Set(options.tools.map((tool) => tool.function.name))
  const usage: Array<Record<string, unknown>> = []
  const schemaTokens = Math.ceil(JSON.stringify(options.tools).length / 3)
  let lastPromptTokens = 0
  let lastEstimate = 0
  let unverifiedStops = 0
  let steps = 0
  const end = async (
    reason: string,
    completion?: Record<string, unknown>,
  ): Promise<AgentResult> => {
    const result: AgentResult = {
      status: completion ? 'completed' : 'incomplete',
      reason,
      steps,
      usage,
      ...(completion ? { completion } : {}),
    }
    await options.record({ event: 'terminal', ...result })
    return result
  }
  for (let step = 1; step <= options.maxSteps; step += 1) {
    if (options.signal?.aborted) return end('cancelled')
    const estimate = estimatedTokens(messages) + schemaTokens
    const projected = Math.max(
      estimate,
      lastPromptTokens + estimate - lastEstimate,
    )
    if (projected + options.maxOutputTokens > options.contextWindow)
      return end('context_limit')
    steps = step
    await options.record({
      event: 'model_request',
      step,
      estimated_input_tokens: projected,
      messages,
      tools: options.tools,
    })
    if (options.signal?.aborted) return end('cancelled')
    let response
    const started = performance.now()
    try {
      response = await options.complete({
        messages,
        tools: options.tools,
        signal: options.signal,
      })
    } catch (error) {
      const receipt =
        error instanceof ProviderResponseError ? error.receipt : null
      if (receipt?.usage) usage.push(receipt.usage)
      await options.record({
        event: 'model_error',
        receipt,
        step,
        error: error instanceof Error ? error.message : String(error),
        elapsed_ms: performance.now() - started,
      })
      return end(options.signal?.aborted ? 'cancelled' : 'provider_error')
    }
    usage.push(response.usage)
    await options.record({
      event: 'model_response',
      step,
      elapsed_ms: performance.now() - started,
      ...response,
    })
    lastPromptTokens =
      typeof response.usage.prompt_tokens === 'number'
        ? response.usage.prompt_tokens
        : projected
    lastEstimate = estimate
    if (options.signal?.aborted) return end('cancelled')
    if (response.finishReason === 'length') return end('output_limit')
    if (!['stop', 'tool_calls'].includes(response.finishReason))
      return end(`provider_finish_${response.finishReason}`)
    messages.push(response.message)
    const calls = response.message.tool_calls ?? []
    if (!calls.length) {
      unverifiedStops += 1
      if (unverifiedStops >= 2) return end('no_verified_completion')
      messages.push({
        role: 'user',
        content:
          'The run has no verified final edit yet. Continue using tools, and call finish_edit after visually selecting and exporting a candidate. If blocked, explain the concrete limitation.',
      })
      continue
    }
    unverifiedStops = 0
    const images: Array<TextPart | ImagePart> = []
    for (const call of calls) {
      if (options.signal?.aborted) return end('cancelled')
      const toolStart = performance.now()
      await options.record({ event: 'tool_call', step, call })
      if (options.signal?.aborted) return end('cancelled')
      let execution: ToolExecution
      let args: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(call.function.arguments)
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
          throw new Error('Expected an object')
        args = parsed as Record<string, unknown>
        if (!names.has(call.function.name))
          execution = failure(`Unknown tool: ${call.function.name}`)
        else if (call.function.name === 'finish_edit' && calls.length !== 1)
          execution = failure(
            'finish_edit must be called alone after receiving all visual feedback.',
          )
        else execution = await options.execute(call.function.name, args, step)
      } catch (error) {
        execution = failure(
          `Invalid tool arguments or execution: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      await options.record({
        event: 'tool_result',
        step,
        call_id: call.id,
        name: call.function.name,
        elapsed_ms: performance.now() - toolStart,
        ...execution,
      })
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolText(execution.result),
      })
      for (const part of execution.result.content) {
        if (part.type === 'image') {
          images.push({
            type: 'text',
            text: `Image returned by ${call.function.name}, call ${call.id}. Tool data and provenance: ${JSON.stringify(args)}. ${toolText(execution.result)}`,
          })
          images.push({
            type: 'image_url',
            image_url: {
              url: `data:${part.mimeType};base64,${part.data}`,
              detail: 'high',
            },
          })
        }
      }
      if (options.signal?.aborted) return end('cancelled')
      if (execution.terminal) return end(execution.terminal)
      if (execution.completion && !execution.result.isError)
        return end('verified_export', execution.completion)
    }
    if (images.length) messages.push({ role: 'user', content: images })
  }
  return end('step_limit')
}
