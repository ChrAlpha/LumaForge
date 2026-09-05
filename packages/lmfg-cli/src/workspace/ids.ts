import { randomBytes } from 'node:crypto'

const SESSION_ID_RE = /^sess_\d{8}T\d{6}_[0-9a-f]{6}$/

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

export function createSessionId(
  now = new Date(),
  random: () => string = () => randomBytes(3).toString('hex'),
): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `sess_${stamp}_${random()}`
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value)
}

export const formatIterationId = (n: number): string => `iter_${pad(n, 4)}`
export const formatCandidateId = (n: number): string => `cand_${pad(n, 4)}`
export const formatPreviewId = (n: number): string => `prev_${pad(n, 4)}`
