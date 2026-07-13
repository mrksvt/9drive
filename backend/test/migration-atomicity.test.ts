import { describe, it, expect, vi } from 'vitest'
import { migrationService } from '../src/modules/migration/migration.service.js'
import { prisma } from '../src/config/prisma.js'
import { migrationQueue } from '../src/modules/migration/migration-queue-db.js'

describe('Migration Atomicity', () => {
  it('should rollback on failure', async () => {
    // Mock migration session
    vi.mocked(prisma.migrationSession.findUniqueOrThrow).mockResolvedValue({
      id: 'migration1',
      userId: 'user1',
      sourceAccountId: 'source1',
      targetAccountId: 'target1',
      status: 'running',
    })

    // Mock connected accounts
    vi.mocked(prisma.connectedAccount.findUniqueOrThrow).mockImplementation((({ where }) => {
      if (where.id === 'source1') return Promise.resolve({ id: 'source1', provider: 'google_drive' })
      if (where.id === 'target1') return Promise.resolve({ id: 'target1', provider: 'google_drive' })
      throw new Error('Account not found')
    }) as any)

    // Mock transfer service to fail
    vi.mocked(migrationQueue.enqueue).mockImplementation(async (migrationId, type, job) => {
      if (type === 'transfer') {
        await expect(job(new AbortController().signal, () => false)).rejects.toThrow('Transfer failed')
      }
    })

    // Mock transaction rollback
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      try {
        return await fn(prisma)
      } catch (error) {
        // Simulate rollback
        await prisma.migrationSession.update({
          where: { id: 'migration1' },
          data: { status: 'failed' }
        })
        throw error
      }
    })

    // Start migration
    await expect(migrationService.startSelected('migration1', 'user1')).rejects.toThrow('Transfer failed')

    // Verify rollback
    const migration = await prisma.migrationSession.findUniqueOrThrow({
      where: { id: 'migration1' }
    })
    expect(migration.status).toBe('failed')
    expect(migration.errorMessage).toContain('Transfer failed')
  })
})