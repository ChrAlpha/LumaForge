import type { ExportOutputResult } from '@lumaforge/render-engine/export'

import type { RunFullResolutionJpegExportInWorkerInput } from '~/lib/export/full-res-export-client'

import { WorkerBridge } from './worker-bridge'

type ExportClient = {
  run: (
    input: RunFullResolutionJpegExportInWorkerInput,
  ) => Promise<ExportOutputResult>
  dispose: () => void | Promise<void>
}

type ClientApi = {
  run: ExportClient['run']
}

export interface ExportBridgeOptions {
  createClient: () => ExportClient
  idleMs?: number
}

export class ExportBridge {
  private readonly bridge: WorkerBridge<ClientApi>

  constructor(options: ExportBridgeOptions) {
    this.bridge = new WorkerBridge<ClientApi>({
      idleMs: options.idleMs,
      startWorker: () => {
        const client = options.createClient()

        return {
          api: {
            run: client.run.bind(client),
          },
          terminate: () => {
            return client.dispose()
          },
        }
      },
    })
  }

  runExport(
    signal: AbortSignal,
    input: Omit<RunFullResolutionJpegExportInWorkerInput, 'signal'>,
  ) {
    return this.bridge.call('run', signal, { ...input, signal })
  }

  cancelExport() {
    return this.terminate()
  }

  terminate() {
    return this.bridge.terminate()
  }
}
