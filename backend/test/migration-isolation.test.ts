import { describe, it, expect, vi } from 'vitest'
import { migrationService } from '../src/modules/migration/migration.service.js'
import { prisma } from '../src/config/prisma.js'

describe('Migration Isolation', () => {
  it('should reject migration if account is locked', async () => {
    // Mock locked account
    vi.mocked(prisma.connectedAccount.findFirstOrThrow).mockImplementation((({ where }) => {
      if (where.id === 'source1') return Promise.resolve({ id: 'source1', lockedAt: new Date() })
      if (where.id === 'target1') return Promise.resolve({ id: 'target1', lockedAt: null })
      throw new Error('Account not found')
    }) as any)

    // Start migration
    await expect(migrationService.startMigration('source1', 'target1', 'user1')).rejects.toThrow('Source or target account is locked')
  })
})