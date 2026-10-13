const OWNER_LOCK_PREFIX = 'lumaforge-export-attempt-owner:'

/**
 * Exclusive `ifAvailable` Web Locks shared by every page of a test. A lock is
 * released when its callback settles, and a page's lifetime lock when the
 * page closes. `probes` lists the locks a page asked for other than its own
 * lifetime lock.
 */
export function createFakeLocks() {
  const held = new Set<string>()
  const probes: string[] = []

  function forPage(page: string) {
    return {
      async request(
        name: string,
        options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) {
        if (!options.ifAvailable) {
          throw new Error(`fake lock manager does not queue: ${name}`)
        }
        if (name !== `${OWNER_LOCK_PREFIX}${page}`) probes.push(name)
        if (held.has(name)) return callback(null)
        held.add(name)
        try {
          return await callback({ name, mode: 'exclusive' } as Lock)
        } finally {
          held.delete(name)
        }
      },
    } as unknown as Pick<LockManager, 'request'>
  }

  return {
    forPage,
    probes,
    closePage(page: string) {
      held.delete(`${OWNER_LOCK_PREFIX}${page}`)
    },
  }
}
