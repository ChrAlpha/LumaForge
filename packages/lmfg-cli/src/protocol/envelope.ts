import type { ErrorEnvelope, LmfgError } from './errors'

export type SuccessEnvelope<T> = {
  schema: string
  ok: true
  result: T
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope

export function successEnvelope<T>(
  schema: string,
  result: T,
): SuccessEnvelope<T> {
  return { schema, ok: true, result }
}

export function errorEnvelope(error: LmfgError): ErrorEnvelope {
  return error.toEnvelope()
}
