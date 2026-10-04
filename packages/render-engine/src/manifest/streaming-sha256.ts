// Incremental SHA-256 for chunked OutputSink writes.
//
// Pure-JS FIPS 180-4 implementation. Used by browser OutputSink
// implementations that need to digest chunked writes without buffering the
// full output (the OPFS path's whole reason for existing). Node sinks MAY
// use `node:crypto.createHash('sha256')` directly for native speed; this
// module is the universal fallback and the v1 reference.
//
// Algorithm: FIPS PUB 180-4 §6.2 SHA-256.
// JS arithmetic notes: bitwise operators coerce to int32, so the `>>> 0`
// after every addition forces the modulo-2^32 result. ROTR(n) on a 32-bit
// word is `(x >>> n) | (x << (32 - n))`.

export interface StreamingSha256 {
  update: (chunk: Uint8Array) => this
  /**
   * Finalize and return the 32-byte digest. Subsequent calls return the
   * same digest; further `update()` throws.
   */
  digest: () => Uint8Array
  /** Convenience: `digest()` as lowercase hex. */
  digestHex: () => string
}

// FIPS 180-4 §5.3.3 initial hash values (first 32 bits of fractional parts
// of the square roots of the first 8 primes).
const INITIAL_H: ReadonlyArray<number> = [
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C,
  0x1F83D9AB, 0x5BE0CD19,
]

// FIPS 180-4 §4.2.2 round constants (first 32 bits of fractional parts of
// the cube roots of the first 64 primes).
const K: ReadonlyArray<number> = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1,
  0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
  0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174, 0xE49B69C1, 0xEFBE4786,
  0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147,
  0x06CA6351, 0x14292967, 0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
  0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B,
  0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A,
  0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
  0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
]

class Sha256Impl implements StreamingSha256 {
  private readonly h: Uint32Array
  private readonly buffer: Uint8Array
  private readonly bufferView: DataView
  private bufferLen: number
  private totalBytes: number
  private finalized: boolean
  private digestBytes: Uint8Array | null

  constructor() {
    this.h = new Uint32Array(INITIAL_H)
    this.buffer = new Uint8Array(64)
    this.bufferView = new DataView(this.buffer.buffer)
    this.bufferLen = 0
    this.totalBytes = 0
    this.finalized = false
    this.digestBytes = null
  }

  update(chunk: Uint8Array): this {
    if (this.finalized) {
      throw new Error('STREAMING_SHA256_FINALIZED')
    }
    let chunkOffset = 0
    let chunkRemaining = chunk.byteLength
    this.totalBytes += chunkRemaining

    if (this.bufferLen > 0) {
      const fillCount = Math.min(64 - this.bufferLen, chunkRemaining)
      this.buffer.set(
        chunk.subarray(chunkOffset, chunkOffset + fillCount),
        this.bufferLen,
      )
      this.bufferLen += fillCount
      chunkOffset += fillCount
      chunkRemaining -= fillCount
      if (this.bufferLen === 64) {
        this.processBlock(this.buffer, 0)
        this.bufferLen = 0
      }
    }

    while (chunkRemaining >= 64) {
      this.processBlock(chunk, chunkOffset)
      chunkOffset += 64
      chunkRemaining -= 64
    }

    if (chunkRemaining > 0) {
      this.buffer.set(
        chunk.subarray(chunkOffset, chunkOffset + chunkRemaining),
        0,
      )
      this.bufferLen = chunkRemaining
    }

    return this
  }

  digest(): Uint8Array {
    if (this.digestBytes) {
      // Return a fresh copy on each call so the caller cannot mutate state.
      return new Uint8Array(this.digestBytes)
    }

    const totalBits = this.totalBytes * 8
    this.buffer[this.bufferLen++] = 0x80
    if (this.bufferLen > 56) {
      while (this.bufferLen < 64) {
        this.buffer[this.bufferLen++] = 0
      }
      this.processBlock(this.buffer, 0)
      this.bufferLen = 0
    }
    while (this.bufferLen < 56) {
      this.buffer[this.bufferLen++] = 0
    }
    // 64-bit big-endian length. Math.floor(.. / 2^32) gives upper 32 bits;
    // bit-OR with 0 truncates to int32 for the low half, then >>>0 to
    // unsigned.
    const high = Math.floor(totalBits / 0x100000000)
    const low = totalBits >>> 0
    this.bufferView.setUint32(56, high >>> 0, false)
    this.bufferView.setUint32(60, low, false)
    this.processBlock(this.buffer, 0)
    this.bufferLen = 0
    this.finalized = true

    const out = new Uint8Array(32)
    const outView = new DataView(out.buffer)
    for (let i = 0; i < 8; i += 1) {
      outView.setUint32(i * 4, this.h[i] >>> 0, false)
    }
    this.digestBytes = out
    return new Uint8Array(out)
  }

  digestHex(): string {
    return bytesToHex(this.digest())
  }

  private processBlock(input: Uint8Array, blockOffset: number): void {
    const W = new Uint32Array(64)
    const view = new DataView(input.buffer, input.byteOffset + blockOffset, 64)

    for (let i = 0; i < 16; i += 1) {
      W[i] = view.getUint32(i * 4, false)
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = W[i - 15]
      const w2 = W[i - 2]
      const s0 =
        ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)
      const s1 =
        ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
    }

    let a = this.h[0]
    let b = this.h[1]
    let c = this.h[2]
    let d = this.h[3]
    let e = this.h[4]
    let f = this.h[5]
    let g = this.h[6]
    let h = this.h[7]

    for (let i = 0; i < 64; i += 1) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    this.h[0] = (this.h[0] + a) >>> 0
    this.h[1] = (this.h[1] + b) >>> 0
    this.h[2] = (this.h[2] + c) >>> 0
    this.h[3] = (this.h[3] + d) >>> 0
    this.h[4] = (this.h[4] + e) >>> 0
    this.h[5] = (this.h[5] + f) >>> 0
    this.h[6] = (this.h[6] + g) >>> 0
    this.h[7] = (this.h[7] + h) >>> 0
  }
}

const HEX_TABLE: ReadonlyArray<string> = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
)

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    hex += HEX_TABLE[bytes[i]]
  }
  return hex
}

/**
 * Create a new streaming SHA-256 state. Append bytes with `update()`; close
 * with `digest()` or `digestHex()`.
 */
export function createStreamingSha256(): StreamingSha256 {
  return new Sha256Impl()
}

/**
 * One-shot convenience: digest a single buffer in one call. Equivalent to
 * `createStreamingSha256().update(bytes).digestHex()`.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256Impl().update(bytes).digestHex()
}
