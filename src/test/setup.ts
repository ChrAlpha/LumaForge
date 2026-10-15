import '@testing-library/jest-dom/vitest'

// jsdom's Blob lacks the browser byte, text, and stream readers.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
}
if (!Blob.prototype.text) {
  Blob.prototype.text = async function () {
    return new TextDecoder().decode(await this.arrayBuffer())
  }
}
if (!Blob.prototype.stream) {
  Blob.prototype.stream = function () {
    let offset = 0
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: async (controller) => {
        if (offset >= this.size) {
          controller.close()
          return
        }
        const chunk = this.slice(offset, offset + 65_536)
        offset += chunk.size
        controller.enqueue(new Uint8Array(await chunk.arrayBuffer()))
      },
    })
  }
}
