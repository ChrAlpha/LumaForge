import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { evaluatePair } from './evaluation.js'
import { ProviderResponseError } from './provider.js'
import type { Complete, ModelRequest, ModelResponse } from './types.js'

// Two real 8 x 8 JPEGs encoded at the same quality; only the scan differs.
const WHITE =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALLAB//Z'
const DARK = WHITE.replace('ALLAB//Z', 'AJNAB//Z')
const assessment = {
  intent: 'The dark frame preserves the quiet mood.',
  color: 'Stone stays neutral while the leaves remain gold.',
  tonal_hierarchy: 'Bright foliage draws attention inside a darker doorway.',
  artifacts: 'No obvious halo is visible at this image size.',
  strengths: ['The doorway remains a clear dark frame.'],
  defects: [],
}
const verdict = (winner: string) => ({
  winner,
  reason: 'The darker wood directs attention to the foliage.',
  A: assessment,
  B: { ...assessment, defects: ['The frame is slightly less distinct.'] },
})
const response = (winner: string, index = 0): ModelResponse => ({
  id: `verdict-${index}`,
  model: 'judge-build',
  finishReason: 'tool_calls',
  usage: {
    prompt_tokens: 300 + index,
    completion_tokens: 50,
    total_tokens: 370 + index,
    completion_tokens_details: { reasoning_tokens: 20 },
    cost_in_usd_ticks: 123456,
  },
  message: {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `call-${index}`,
        type: 'function',
        function: {
          name: 'submit_comparison',
          arguments: JSON.stringify(verdict(winner)),
        },
      },
    ],
  },
})

function imageUrls(request: ModelRequest): string[] {
  return request.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === 'image_url' ? [part.image_url.url] : [],
        )
      : [],
  )
}

describe('independent reversed-position image evaluation', () => {
  let cwd: string
  let baselinePath: string
  let candidatePath: string
  let events: Array<Record<string, unknown>>
  const brief =
    'Keep the doorway dark and quiet while preserving golden leaves.'

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lmfg-comparison-'))
    baselinePath = join(cwd, 'baseline-private-name.jpg')
    candidatePath = join(cwd, 'candidate-private-name.jpg')
    await writeFile(baselinePath, Buffer.from(WHITE, 'base64'))
    await writeFile(candidatePath, Buffer.from(DARK, 'base64'))
    events = []
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const run = (complete: Complete, seed = 'frozen-seed') =>
    evaluatePair({
      brief,
      baselinePath,
      candidatePath,
      complete,
      seed,
      record: async (event) => {
        events.push(event)
      },
    })

  it('sends fresh blinded contexts, reverses exact bytes, and preserves each receipt', async () => {
    const requests: ModelRequest[] = []
    const result = await run(async (request) => {
      requests.push(request)
      const index = requests.length - 1
      const winner = imageUrls(request)[0].endsWith(DARK) ? 'A' : 'B'
      return response(winner, index)
    })
    expect(requests).toHaveLength(2)
    expect(imageUrls(requests[1])).toEqual(imageUrls(requests[0]).toReversed())
    const withoutPixels = (request: ModelRequest) =>
      JSON.stringify(request).replace(
        /data:image\/jpeg;base64,[^"]+/g,
        '[pixels]',
      )
    expect(withoutPixels(requests[0])).toBe(withoutPixels(requests[1]))
    expect(new Set(imageUrls(requests[0]))).toEqual(
      new Set([
        `data:image/jpeg;base64,${WHITE}`,
        `data:image/jpeg;base64,${DARK}`,
      ]),
    )
    for (const request of requests) {
      const serialized = JSON.stringify(request)
      expect(request.messages.map((message) => message.role)).toEqual([
        'system',
        'user',
      ])
      expect(request.tools.map((tool) => tool.function.name)).toEqual([
        'submit_comparison',
      ])
      expect(serialized).toContain(brief)
      for (const forbidden of [
        baselinePath,
        candidatePath,
        'baseline-private-name',
        'candidate-private-name',
        'verdict-0',
        'exposure_ev',
        'luma.mean',
        assessment.intent,
        'candidate',
        'baseline',
      ])
        expect(serialized).not.toContain(forbidden)
    }
    expect(result).toMatchObject({ status: 'completed', winner: 'candidate' })
    const judgments = result.judgments as Array<{ receipt: unknown }>
    expect(judgments.map((entry) => entry.receipt)).toEqual(
      [0, 1].map((index) => ({
        id: `verdict-${index}`,
        model: 'judge-build',
        usage: response('A', index).usage,
      })),
    )
    expect(JSON.stringify(events)).not.toContain(WHITE)
    expect(result).toMatchObject({
      images: {
        baseline: {
          width: 8,
          height: 8,
          sha256: createHash('sha256')
            .update(Buffer.from(WHITE, 'base64'))
            .digest('hex'),
        },
      },
    })
  })

  it('uses the seed reproducibly without disclosing it to either judge', async () => {
    const firstOrders: string[][] = []
    for (let round = 0; round < 2; round += 1) {
      let index = 0
      await run(async (request) => {
        if (index++ === 0) firstOrders.push(imageUrls(request))
        expect(JSON.stringify(request)).not.toContain('frozen-seed')
        return response('tie')
      })
    }
    expect(firstOrders[0]).toEqual(firstOrders[1])
  })

  it.each([
    ['tie', 'tie', 'completed', 'tie'],
    ['A', 'A', 'inconclusive', null],
    ['tie', 'B', 'inconclusive', null],
    ['uncertain', 'uncertain', 'inconclusive', null],
  ])(
    'handles %s / %s verdicts without hiding position disagreement',
    async (first, second, status, winner) => {
      let index = 0
      const result = await run(async () =>
        response(index++ === 0 ? first! : second!),
      )
      expect(result).toMatchObject({ status, winner })
      expect(result.judgments).toHaveLength(2)
    },
  )

  it.each([
    'length',
    'missing',
    'extra',
    'json',
    'empty-observation',
    'wrong-tool',
    'invalid-winner',
    'extra-field',
  ])('rejects %s grading while keeping its usage', async (failure) => {
    let calls = 0
    const result = await run(async () => {
      const output = response('A', calls++)
      if (calls !== 1) return output
      if (failure === 'length') output.finishReason = 'length'
      if (failure === 'missing') output.message.tool_calls = []
      if (failure === 'extra')
        output.message.tool_calls!.push(output.message.tool_calls![0])
      if (failure === 'json')
        output.message.tool_calls![0].function.arguments = '{'
      if (failure === 'empty-observation')
        output.message.tool_calls![0].function.arguments = JSON.stringify({
          ...verdict('A'),
          A: { ...assessment, intent: '' },
        })
      if (failure === 'wrong-tool')
        output.message.tool_calls![0].function.name = 'finish_edit'
      if (failure === 'invalid-winner')
        output.message.tool_calls![0].function.arguments = JSON.stringify(
          verdict('candidate'),
        )
      if (failure === 'extra-field')
        output.message.tool_calls![0].function.arguments = JSON.stringify({
          ...verdict('A'),
          exposure_ev: 2,
        })
      return output
    })
    expect(result).toMatchObject({ status: 'inconclusive', winner: null })
    expect(result.judgments).toMatchObject([
      { verdict: null, receipt: { usage: response('A').usage } },
      {},
    ])
    expect(events.some((event) => event.event === 'comparison_invalid')).toBe(
      true,
    )
    expect(result.usage).toEqual([
      response('A', 0).usage,
      response('A', 1).usage,
    ])
    expect(
      events.findIndex((event) => event.event === 'comparison_response'),
    ).toBeLessThan(
      events.findIndex((event) => event.event === 'comparison_invalid'),
    )
  })

  it('preserves receipts for provider validation failures without retrying the same order', async () => {
    let calls = 0
    const receipt = {
      id: 'failed-receipt',
      model: 'judge',
      usage: { total_tokens: 123 },
    }
    const result = await run(async () => {
      if (calls++ === 0)
        throw new ProviderResponseError('Invalid tools', receipt)
      return response('tie')
    })
    expect(calls).toBe(2)
    expect(result).toMatchObject({
      status: 'inconclusive',
      judgments: [{ receipt }, {}],
    })
  })

  it('refuses identical image bytes without spending a model call', async () => {
    await writeFile(candidatePath, Buffer.from(WHITE, 'base64'))
    let calls = 0
    const result = await run(async () => {
      calls += 1
      return response('A')
    })
    expect(calls).toBe(0)
    expect(result).toMatchObject({
      status: 'no_visual_difference',
      winner: null,
      judgments: [],
    })
  })

  it('can select the baseline and freezes pixels before either request', async () => {
    let calls = 0
    const result = await run(async (request) => {
      if (calls++ === 0) await writeFile(baselinePath, 'replaced while judging')
      expect(imageUrls(request)).toContain(`data:image/jpeg;base64,${WHITE}`)
      return response(imageUrls(request)[0].endsWith(WHITE) ? 'A' : 'B')
    })
    expect(result).toMatchObject({ status: 'completed', winner: 'baseline' })
  })

  it('does not convert unknown provider billing into a successful zero-cost judgment', async () => {
    let calls = 0
    const result = await run(async () => {
      calls += 1
      throw new Error('Connection interrupted; billing unknown.')
    })
    expect(calls).toBe(2)
    expect(result).toMatchObject({
      status: 'inconclusive',
      winner: null,
      judgments: [
        { receipt: null, verdict: null },
        { receipt: null, verdict: null },
      ],
    })
    expect(
      events.filter((event) => event.event === 'comparison_error'),
    ).toHaveLength(2)
  })

  it('stops before another paid request when the recorder cannot persist the response', async () => {
    let calls = 0
    await expect(
      evaluatePair({
        brief,
        baselinePath,
        candidatePath,
        seed: 'frozen-seed',
        complete: async () => response('tie', calls++),
        record: async (event) => {
          if (event.event === 'comparison_response')
            throw new Error('disk full')
        },
      }),
    ).rejects.toThrow('disk full')
    expect(calls).toBe(1)
  })

  it.each([225, 237, 254])(
    'rejects identity-bearing JPEG marker %i before a model request',
    async (marker) => {
      const bytes = Buffer.from(DARK, 'base64')
      const identity = Buffer.from('candidate-private-name.jpg; exposure_ev=2')
      const header = Buffer.from([255, marker, 0, identity.length + 2])
      await writeFile(
        candidatePath,
        Buffer.concat([
          bytes.subarray(0, 2),
          header,
          identity,
          bytes.subarray(2),
        ]),
      )
      let calls = 0
      await expect(run(async () => response('tie', calls++))).rejects.toThrow(
        /metadata|comments/,
      )
      expect(calls).toBe(0)
    },
  )

  it.each(['pixels', 'empty-scan', 'truncated', 'trailing', 'directory'])(
    'rejects %s image content',
    async (failure) => {
      const bytes = Buffer.from(DARK, 'base64')
      if (failure === 'pixels') {
        const frame = bytes.indexOf(Buffer.from([255, 192]))
        bytes.writeUInt16BE(65_535, frame + 5)
        bytes.writeUInt16BE(65_535, frame + 7)
        await writeFile(candidatePath, bytes)
      } else if (failure === 'empty-scan') {
        const scan = bytes.indexOf(Buffer.from([255, 218]))
        await writeFile(
          candidatePath,
          Buffer.concat([
            bytes.subarray(0, scan + 2 + bytes.readUInt16BE(scan + 2)),
            Buffer.from([255, 217]),
          ]),
        )
      } else if (failure === 'truncated')
        await writeFile(candidatePath, bytes.subarray(0, -2))
      else if (failure === 'trailing')
        await writeFile(
          candidatePath,
          Buffer.concat([bytes, Buffer.from([255, 217])]),
        )
      else candidatePath = cwd
      let calls = 0
      await expect(run(async () => response('tie', calls++))).rejects.toThrow()
      expect(calls).toBe(0)
    },
  )

  it.each(['dimensions', 'malformed', 'oversized', 'symlink'])(
    'rejects %s input before calling the judge',
    async (failure) => {
      const bytes = Buffer.from(DARK, 'base64')
      if (failure === 'dimensions') {
        const frame = bytes.indexOf(Buffer.from([255, 192]))
        bytes.writeUInt16BE(9, frame + 5)
        await writeFile(candidatePath, bytes)
      } else if (failure === 'malformed') {
        const frame = bytes.indexOf(Buffer.from([255, 192]))
        await writeFile(
          candidatePath,
          Buffer.concat([
            bytes.subarray(0, frame + 2 + bytes.readUInt16BE(frame + 2)),
            Buffer.from([255, 217]),
          ]),
        )
      } else if (failure === 'oversized') {
        await truncate(candidatePath, 8 * 1024 * 1024 + 1)
      } else {
        await rm(candidatePath)
        await symlink(baselinePath, candidatePath)
      }
      let calls = 0
      await expect(
        run(async () => {
          calls += 1
          return response('A')
        }),
      ).rejects.toThrow()
      expect(calls).toBe(0)
    },
  )

  it.each(['quantization', 'sampling'])(
    'rejects mismatched JPEG %s before judging',
    async (difference) => {
      const bytes = Buffer.from(DARK, 'base64')
      const marker = bytes.indexOf(
        Buffer.from([255, difference === 'quantization' ? 219 : 192]),
      )
      bytes[marker + (difference === 'quantization' ? 5 : 11)] ^= 1
      await writeFile(candidatePath, bytes)
      let calls = 0
      await expect(run(async () => response('tie', calls++))).rejects.toThrow(
        /equal JPEG/,
      )
      expect(calls).toBe(0)
    },
  )
})
