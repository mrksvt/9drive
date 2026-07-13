import { describe, it, expect, vi } from 'vitest'
import { transferService } from '../src/modules/migration/transfer.service.js'
import { prisma } from '../src/config/prisma.js'
import { scanResultService } from '../src/modules/mongodb/scan-result.service.js'

describe('Migration Durability', () => {
  it('should rollback on checksum mismatch', async () => {
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

    // Mock scan result with checksum
    vi.mocked(scanResultService.getBySourceFileId).mockResolvedValue({
      sourceFileId: 'file1',
      checksum: 'sha256:source-checksum',
    })

    // Mock transfer service with checksum mismatch
    vi.mocked(transferService.transferFile).mockResolvedValue({
      providerFileId: 'target-file1',
      checksum: 'sha256:target-checksum', // Mismatch
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

    // Execute migration
    await expect(transferService.executeMigration('migration1', 'user1', new AbortController().signal, () => false))
      .rejects.toThrow('Checksum mismatch')

    // Verify rollback
    const migration = await prisma.migrationSession.findUniqueOrThrow({
      where: { id: 'migration1' }
    })
    expect(migration.status).toBe('failed')
  })
})