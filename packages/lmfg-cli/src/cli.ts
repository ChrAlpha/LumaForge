export type CliIo = {
  stdout: (chunk: string) => void
  stderr: (chunk: string) => void
  cwd: string
}

export async function runCli(
  argv: readonly string[],
  io?: CliIo,
): Promise<number> {
  void io
  return argv.length === 0 ? 0 : 0
}
