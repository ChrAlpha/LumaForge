import type {
  HistogramWorkerRequest,
  HistogramWorkerResponse,
} from './histogram-worker-runtime'
import { createHistogramWorkerRuntime } from './histogram-worker-runtime'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<HistogramWorkerRequest>) => void) | null
  postMessage: (response: HistogramWorkerResponse) => void
}

// A run yields through its own channel rather than a timer, which a worker
// clamps once timers nest, so a cancel lands within one slice.
const channel = new MessageChannel()
const resumes: (() => void)[] = []
channel.port1.onmessage = () => resumes.shift()?.()

const runtime = createHistogramWorkerRuntime(
  (response) => scope.postMessage(response),
  () =>
    new Promise<void>((resolve) => {
      resumes.push(resolve)
      channel.port2.postMessage(null)
    }),
)

scope.onmessage = (event) => {
  runtime.handle(event.data)
}
