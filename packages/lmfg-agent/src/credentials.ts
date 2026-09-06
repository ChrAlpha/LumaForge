import process from 'node:process'

async function readKey(): Promise<string> {
  const input = process.stdin
  const terminal = input.isTTY
  if (terminal) {
    process.stderr.write('Runtime API key (hidden): ')
    input.setRawMode(true)
  }
  input.setEncoding('utf8')
  return await new Promise<string>((resolveKey, reject) => {
    let key = ''
    const finish = (error?: Error) => {
      input.off('data', data)
      input.off('end', end)
      if (terminal) {
        input.setRawMode(false)
        process.stderr.write('\n')
      }
      input.pause()
      if (error) reject(error)
      else resolveKey(key.trim())
    }
    const data = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          finish(new Error('Cancelled'))
          return
        }
        if (char === '\n' || char === '\r') {
          finish()
          return
        }
        if (char === '\u007F') key = key.slice(0, -1)
        else key += char
      }
    }
    const end = () => finish()
    input.on('data', data)
    input.once('end', end)
    input.resume()
  })
}

export async function readRuntimeApiKey(fromStdin: boolean): Promise<string> {
  const key = fromStdin ? await readKey() : process.env.LMFG_AGENT_API_KEY
  if (!key?.trim())
    throw new Error(
      'Supply LMFG_AGENT_API_KEY or --key-stdin. Credentials are never accepted as command arguments.',
    )
  return key.trim()
}
