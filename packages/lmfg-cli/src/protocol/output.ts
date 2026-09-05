import type { SuccessEnvelope } from './envelope'
import type { LmfgError } from './errors'

export type EmitMode = 'json' | 'ndjson'

export type OutputIo = {
  stdout: (chunk: string) => void
  stderr: (chunk: string) => void
}

export type OutputOptions = OutputIo & {
  emit: EmitMode
  quiet: boolean
  color: boolean
}

export type LmfgEvent = { event: string } & Record<string, unknown>

export const EVENT_SCHEMA = 'lmfg.event.v1'

export class Output {
  readonly emit: EmitMode
  private readonly quiet: boolean
  private readonly io: OutputIo

  constructor(options: OutputOptions) {
    this.emit = options.emit
    this.quiet = options.quiet
    this.io = { stdout: options.stdout, stderr: options.stderr }
  }

  /** Progress event. Streamed in ndjson mode; a one-line stderr note in json mode. */
  event(event: LmfgEvent): void {
    if (this.emit === 'ndjson') {
      this.io.stdout(`${JSON.stringify({ ...event, schema: EVENT_SCHEMA })}\n`)
      return
    }
    this.log(`[${event.event}]${describeEvent(event)}`)
  }

  result<T>(envelope: SuccessEnvelope<T>): void {
    if (this.emit === 'ndjson') {
      this.io.stdout(
        `${JSON.stringify({
          event: 'completed',
          ok: true,
          schema: EVENT_SCHEMA,
          result_schema: envelope.schema,
          result: envelope.result,
        })}\n`,
      )
      return
    }
    this.io.stdout(`${JSON.stringify(envelope)}\n`)
  }

  error(error: LmfgError): void {
    const envelope = error.toEnvelope()
    if (this.emit === 'ndjson') {
      this.io.stdout(
        `${JSON.stringify({ event: 'completed', ok: false, schema: EVENT_SCHEMA, error: envelope.error })}\n`,
      )
      return
    }
    this.io.stdout(`${JSON.stringify(envelope)}\n`)
  }

  /** Human diagnostics; never on stdout. */
  log(message: string): void {
    if (this.quiet) return
    this.io.stderr(`${message}\n`)
  }
}

function describeEvent(event: LmfgEvent): string {
  const parts = Object.entries(event)
    .filter(([key]) => key !== 'event' && key !== 'schema')
    .map(
      ([key, value]) =>
        `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
    )
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}
