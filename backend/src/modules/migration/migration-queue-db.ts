import { prisma } from '../../config/prisma.js'

export interface JobProcessor {
  (signal: AbortSignal, isPaused: () => boolean): Promise<void>
}

export class DatabaseMigrationQueue {
  private active = new Map<string, { abort: AbortController; paused: boolean; promise: Promise<void> }>()
  private pollingInterval: ReturnType<typeof setInterval> | null = null

  /**
   * Start polling for pending jobs
   */
  start(intervalMs = 5000): void {
    if (this.pollingInterval) return

    this.pollingInterval = setInterval(async () => {
      await this.processPendingJobs()
    }, intervalMs)

    // Process immediately on start
    this.processPendingJobs()
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval)
      this.pollingInterval = null
    }
  }

  /**
   * Enqueue a migration job
   */
  async enqueue(
    migrationId: string,
    type: 'scan' | 'transfer' | 'retry',
    processor: JobProcessor,
    payload?: Record<string, unknown>
  ): Promise<string> {
    // Check if there's already an active job for this migration
    if (this.active.has(migrationId)) {
      return migrationId
    }

    // Create job record in database
    const job = await prisma.migrationJob.create({
      data: {
        migrationId,
        type,
        status: 'pending',
        payload: payload ? JSON.parse(JSON.stringify(payload)) : undefined
      }
    })

    // Start processing this job
    this.processJob(job.id, migrationId, processor)

    return job.id
  }

  /**
   * Process a specific job
   */
  private async processJob(
    jobId: string,
    migrationId: string,
    processor: JobProcessor
  ): Promise<void> {
    const abort = new AbortController()
    let paused = false
    const isPaused = () => paused

    // Update job status to running
    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date() }
    })

    // Store in active map
    this.active.set(migrationId, {
      abort,
      paused,
      promise: processor(abort.signal, isPaused)
        .then(async () => {
          await prisma.migrationJob.update({
            where: { id: jobId },
            data: { status: 'completed', completedAt: new Date() }
          })
        })
        .catch(async (error) => {
          const msg = error instanceof Error ? error.message : 'Job failed'
          console.error('[MIGRATION-QUEUE] job failed:', jobId, msg, error instanceof Error ? error.stack : '')
          await prisma.migrationJob.update({
            where: { id: jobId },
            data: {
              status: 'failed',
              errorMessage: msg,
              completedAt: new Date(),
              retryCount: { increment: 1 }
            }
          })
        })
        .finally(() => {
          this.active.delete(migrationId)
        })
    })
  }

  /**
   * Process pending jobs from database
   */
  private async processPendingJobs(): Promise<void> {
    try {
      // Find pending jobs that haven't exceeded max retries
      const pendingJobs = await prisma.migrationJob.findMany({
        where: {
          status: 'pending',
          retryCount: { lt: prisma.migrationJob.fields.maxRetries }
        },
        orderBy: { createdAt: 'asc' },
        take: 5 // Process up to 5 jobs at a time
      })

      for (const job of pendingJobs) {
        // Skip if already active
        if (this.active.has(job.migrationId)) continue

        // Create processor based on job type
        const processor = this.createProcessor(job.type, job.payload)
        if (processor) {
          this.processJob(job.id, job.migrationId, processor)
        }
      }
    } catch (error) {
      console.error('Error processing pending jobs:', error)
    }
  }

  /**
   * Create processor function based on job type
   */
  private createProcessor(
    type: string,
    payload: unknown
  ): JobProcessor | null {
    // This will be implemented to create appropriate processors
    // For now, return null - actual implementation will depend on
    // scanner.service.ts and transfer.service.ts
    return null
  }

  /**
   * Pause a migration job
   */
  async pause(migrationId: string): Promise<void> {
    const entry = this.active.get(migrationId)
    if (entry) {
      entry.paused = true
    }

    // Update database status
    await prisma.migrationJob.updateMany({
      where: {
        migrationId,
        status: 'running'
      },
      data: { status: 'paused' }
    })
  }

  /**
   * Resume a migration job
   */
  async resume(migrationId: string): Promise<void> {
    const entry = this.active.get(migrationId)
    if (entry) {
      entry.paused = false
    }

    // Update database status
    await prisma.migrationJob.updateMany({
      where: {
        migrationId,
        status: 'paused'
      },
      data: { status: 'running' }
    })
  }

  /**
   * Cancel a migration job
   */
  async cancel(migrationId: string): Promise<void> {
    const entry = this.active.get(migrationId)
    if (entry) {
      entry.abort.abort()
      this.active.delete(migrationId)
    }

    // Update database status
    await prisma.migrationJob.updateMany({
      where: {
        migrationId,
        status: { in: ['pending', 'running', 'paused'] }
      },
      data: {
        status: 'cancelled',
        completedAt: new Date()
      }
    })
  }

  /**
   * Check if a migration is currently running
   */
  isRunning(migrationId: string): boolean {
    const entry = this.active.get(migrationId)
    return !!entry && !entry.paused
  }

  /**
   * Check if a migration is currently paused
   */
  isPaused(migrationId: string): boolean {
    const entry = this.active.get(migrationId)
    return !!entry && entry.paused
  }

  /**
   * Check if a migration is active (running or paused)
   */
  isActive(migrationId: string): boolean {
    return this.active.has(migrationId)
  }

  /**
   * Get job status for a migration
   */
  async getJobStatus(migrationId: string) {
    const jobs = await prisma.migrationJob.findMany({
      where: { migrationId },
      orderBy: { createdAt: 'desc' },
      take: 10
    })

    return jobs
  }

  /**
   * Retry failed jobs for a migration
   */
  async retryFailed(migrationId: string): Promise<number> {
    const failedJobs = await prisma.migrationJob.findMany({
      where: {
        migrationId,
        status: 'failed',
        retryCount: { lt: prisma.migrationJob.fields.maxRetries }
      }
    })

    for (const job of failedJobs) {
      await prisma.migrationJob.update({
        where: { id: job.id },
        data: { status: 'pending', errorMessage: null }
      })
    }

    return failedJobs.length
  }

  /**
   * Clean up old completed/failed jobs
   */
  async cleanup(olderThanDays = 30): Promise<number> {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - olderThanDays)

    const result = await prisma.migrationJob.deleteMany({
      where: {
        status: { in: ['completed', 'failed', 'cancelled'] },
        createdAt: { lt: cutoff }
      }
    })

    return result.count
  }
}

export const migrationQueue = new DatabaseMigrationQueue()
