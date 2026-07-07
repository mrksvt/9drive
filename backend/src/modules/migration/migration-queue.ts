type QueueEntry = {
  abort: AbortController
  paused: boolean
  promise: Promise<void>
}

class MigrationQueue {
  private active = new Map<string, QueueEntry>()

  async enqueue(
    migrationId: string,
    processor: (signal: AbortSignal, isPaused: () => boolean) => Promise<void>,
  ): Promise<void> {
    if (this.active.has(migrationId)) return

    const abort = new AbortController()
    let paused = false

    const isPaused = () => paused

    const promise = processor(abort.signal, isPaused).finally(() => {
      this.active.delete(migrationId)
    })

    this.active.set(migrationId, { abort, paused, promise })
  }

  pause(migrationId: string): void {
    const entry = this.active.get(migrationId)
    if (entry) entry.paused = true
  }

  resume(migrationId: string): void {
    const entry = this.active.get(migrationId)
    if (entry) entry.paused = false
  }

  cancel(migrationId: string): void {
    const entry = this.active.get(migrationId)
    if (entry) {
      entry.abort.abort()
      this.active.delete(migrationId)
    }
  }

  isRunning(migrationId: string): boolean {
    return this.active.has(migrationId) && !this.active.get(migrationId)!.paused
  }

  isPaused(migrationId: string): boolean {
    return this.active.has(migrationId) && this.active.get(migrationId)!.paused
  }

  isActive(migrationId: string): boolean {
    return this.active.has(migrationId)
  }
}

export const migrationQueue = new MigrationQueue()
