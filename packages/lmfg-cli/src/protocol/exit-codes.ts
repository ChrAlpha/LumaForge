// Spec §4.4 exit codes.
export const EXIT_CODES = {
  ok: 0,
  failure: 1,
  invalidArguments: 2,
  unsupported: 3,
  lutContract: 4,
  permission: 5,
  fetch: 6,
  render: 7,
  exportRefused: 8,
  cancelled: 9,
  internal: 10,
} as const

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES]
