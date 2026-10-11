export type SuccessEnvelope<T> = {
  schema: string
  ok: true
  result: T
}

export function successEnvelope<T>(
  schema: string,
  result: T,
): SuccessEnvelope<T> {
  return { schema, ok: true, result }
}
