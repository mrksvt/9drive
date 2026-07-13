import { google } from 'googleapis'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient, ensureGoogleAppFolder, syncGoogleQuota } from '../google/google.service.js'
import { migrateFile } from './file-migrator.js'
import { migrationQueue } from './migration-queue-db.js'
import { transferService } from './transfer.service.js'
import { scanResultService } from '../mongodb/scan-result.service.js'
import { selectAccount } from '../uploads/upload.routes.js'
import { publishMigrationEvent, subscribeMigration as redisSubscribeMigration } from '../redis/progress-pubsub.js'

export type MigrationEvent =
  | { type: 'progress'; data: { completedFiles: number; failedFiles: number; skippedFiles: number; currentFile?: string; percentComplete: number } }
  | { type: 'item-complete'; data: { itemId: string; name: string; status: string } }
  | { type: 'item-failed'; data: { itemId: string; name: string; error: string } }
  | { type: 'complete'; data: { totalFiles: number; completedFiles: number; failedFiles: number; skippedFiles: number } }
  | { type: 'error'; data: { message: string } }

export type ScanProgress = {
  phase: string
  message?: string
  itemsScanned?: number
  totalItems?: number
  percentComplete?: number
}

export { subscribeMigration, emit }

function subscribeMigration(migrationId: string, callback: (event: MigrationEvent | ScanProgress) => void): () => void {
  return redisSubscribeMigration(migrationId, callback)
}

function emit(migrationId: string, event: MigrationEvent): void {
  publishMigrationEvent(migrationId, event)
}

export class MigrationService {
  /**
   * Start a new migration (ACID-compliant)
   */
  async startMigration(sourceAccountId: string, targetAccountId: string, userId: string) {
    // Validate accounts
    const sourceAccount = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: sourceAccountId, userId, status: 'connected' }
    })
    const targetAccount = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: targetAccountId, userId, status: 'connected' }
    })

    // Check if accounts are locked
    if (sourceAccount.lockedAt || targetAccount.lockedAt) {
      throw new Error('Source or target account is locked by another operation.')
    }

    // Create migration session in a transaction
    const migration = await prisma.$transaction(async (tx) => {
      // Lock accounts
      await tx.connectedAccount.updateMany({
        where: { id: { in: [sourceAccountId, targetAccountId] } },
        data: { lockedAt: new Date() }
      })

      // Create migration session
      return tx.migrationSession.create({
        data: {
          userId,
          sourceAccountId,
          targetAccountId,
          status: 'pending',
          transactionId: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        }
      })
    })

    // Start scan
    await this.startScan(migration.id, userId)
    return migration
  }

  /**
   * Start scan for migration
   */
  async startScan(migrationId: string, userId: string) {
    const migration = await prisma.migrationSession.findFirstOrThrow({
      where: { id: migrationId, userId, status: 'pending' }
    })

    await prisma.migrationSession.update({
      where: { id: migrationId },
      data: { status: 'scanning', startedAt: new Date() }
    })

    // Enqueue scan job
    await migrationQueue.enqueue(migrationId, 'scan', async (signal) => {
      try {
        const scanner = new ScannerService()
        await scanner.scanSource(migrationId, migration.sourceAccountId, userId, signal)
        emit(migrationId, { type: 'complete', data: { totalFiles: 0, completedFiles: 0, failedFiles: 0, skippedFiles: 0 } })
      } catch (err) {
        console.error('[MIGRATION] scan error:', err)
        await prisma.migrationSession.update({
          where: { id: migrationId },
          data: { status: 'failed', errorMessage: err instanceof Error ? err.message : 'Scan failed' }
        })
        throw err
      }
    })
  }

  /**
   * Pause a running migration
   */
  async pause(migrationId: string, userId: string) {
    await prisma.migrationSession.findFirstOrThrow({
      where: { id: migrationId, userId, status: 'running' }
    })
    await migrationQueue.pause(migrationId)
    await prisma.migrationSession.update({
      where: { id: migrationId },
      data: { status: 'paused' }
    })
  }

  /**
   * Resume a paused migration
   */
  async resume(migrationId: string, userId: string) {
    await prisma.migrationSession.findFirstOrThrow({
      where: { id: migrationId, userId, status: 'paused' }
    })
    await migrationQueue.resume(migrationId)
    await prisma.migrationSession.update({
      where: { id: migrationId },
      data: { status: 'running' }
    })
  }

  /**
   * Cancel a migration
   */
  async cancel(migrationId: string, userId: string) {
    await prisma.migrationSession.findFirstOrThrow({
      where: {
        id: migrationId,
        userId,
        status: { in: ['pending', 'scanning', 'running', 'paused'] }
      }
    })
    await migrationQueue.cancel(migrationId)
    await prisma.migrationSession.update({
      where: { id: migrationId },
      data: { status: 'cancelled', completedAt: new Date() }
    })
  }

  /**
   * Get migration status with progress
   */
  async getStatus(migrationId: string, userId: string) {
    const migration = await prisma.migrationSession.findFirstOrThrow({
      where: { id: migrationId, userId },
      include: {
        sourceAccount: { select: { email: true, displayName: true } },
        targetAccount: { select: { email: true, displayName: true } }
      }
    })

    const percentComplete =
      migration.totalFiles > 0
        ? Math.min(100, Math.round(
            ((migration.completedFiles + migration.failedFiles + migration.skippedFiles) /
              migration.totalFiles) *
              100
          ))
        : 0

    return {
      ...migration,
      totalBytes: migration.totalBytes.toString(),
      migratedBytes: migration.migratedBytes.toString(),
      percentComplete
    }
  }

  /**
   * Get list of migrations for a user
   */
  async getList(userId: string) {
    // Clean up stuck scanning sessions
    const stuckScanning = await prisma.migrationSession.findMany({
      where: { userId, status: 'scanning' },
      select: { id: true, createdAt: true }
    })

    for (const stuck of stuckScanning) {
      const age = Date.now() - new Date(stuck.createdAt).getTime()
      if (age > 2 * 60_000) {
        await prisma.migrationSession.update({
          where: { id: stuck.id },
          data: { status: 'failed', errorMessage: 'Scan timed out', completedAt: new Date() }
        })
      }
    }

    const migrations = await prisma.migrationSession.findMany({
      where: { userId },
      select: {
        id: true,
        status: true,
        totalFiles: true,
        totalFolders: true,
        completedFiles: true,
        failedFiles: true,
        skippedFiles: true,
        totalBytes: true,
        migratedBytes: true,
        errorMessage: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        sourceAccountId: true,
        sourceAccount: { select: { email: true, displayName: true } },
        targetAccount: { select: { email: true, displayName: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    })

    return migrations.map((m) => ({
      ...m,
      totalBytes: m.totalBytes.toString(),
      migratedBytes: m.migratedBytes.toString(),
      percentComplete:
        m.totalFiles > 0
          ? Math.min(100, Math.round(((m.completedFiles + m.failedFiles + m.skippedFiles) / m.totalFiles) * 100))
          : 0
    }))
  }

  /**
   * Get paginated list of migration items
   */
  async getItems(migrationId: string, userId: string, page: number, limit: number) {
    await prisma.migrationSession.findFirstOrThrow({
      where: { id: migrationId, userId }
    })

    const result = await scanResultService.getByMigration(migrationId, { page, limit })

    return {
      items: result.items.map((i: any) => ({ ...i, sizeBytes: i.sizeBytes })),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages
    }
  }

  /**
   * Retry failed migration items
   */
  async retryFailed(migrationId: string, userId: string) {
    await prisma.migrationSession.findFirstOrThrow({
      where: {
        id: migrationId,
        userId,
        status: { in: ['completed', 'completed_with_errors', 'failed'] }
      }
    })

    // Reset failed items to selected
    await scanResultService.resetFailedToSelected(migrationId)

    // Update session status
    await prisma.migrationSession.update({
      where: { id: migrationId },
      data: { status: 'running', failedFiles: 0, errorMessage: null, completedAt: null }
    })

    // Enqueue transfer job
    await migrationQueue.enqueue(migrationId, 'retry', async (signal, isPaused) => {
      const result = await transferService.executeMigration(
        migrationId,
        userId,
        signal,
        isPaused
      )

      syncGoogleQuota(migrationId).catch(() => undefined)

      emit(migrationId, {
        type: 'complete',
        data: {
          totalFiles: result.totalFiles,
          completedFiles: result.completedFiles,
          failedFiles: result.failedFiles,
          skippedFiles: result.skippedFiles
        }
      })

      setTimeout(() => { /* Redis subscription auto-cleans on unsubscribe */ }, 30_000)
    })

    return { status: 'ok' }
  }

  /**
   * Start migration for selected items
   */
  async startSelected(migrationId: string, userId: string) {
    const migration = await prisma.migrationSession.findFirstOrThrow({
      where: { id: migrationId, userId, status: 'scanned' }
    })

    const selectedItems = await scanResultService.getSelectedItems(migrationId)

    if (selectedItems.length === 0) {
      throw Object.assign(new Error('No items selected.'), { status: 400 })
    }

    const selectedBytes = selectedItems.reduce((sum, i) => sum + BigInt(i.size), 0n)

    // Auto-select ancestor folders
    const ancestorIds = new Set<string>()
    for (const item of selectedItems) {
      let parentId = item.sourceParentId
      while (parentId) {
        if (ancestorIds.has(parentId)) break
        ancestorIds.add(parentId)
        const parent = await scanResultService.getBySourceFileIds(migrationId, [parentId])
        parentId = parent[0]?.sourceParentId ?? null
      }
    }

    if (ancestorIds.size > 0) {
      await scanResultService.updateManyStatus(
        migrationId,
        Array.from(ancestorIds),
        'selected',
        { type: 'folder' }
      )
    }

    // Count final selection
    const allSelected = await scanResultService.getSelectedItems(migrationId)
    const selectedFolders = allSelected.filter((i) => i.type === 'folder')
    const selectedFiles = allSelected.filter((i) => i.type === 'file')

    // Update session
    await prisma.migrationSession.update({
      where: { id: migrationId },
      data: {
        totalFiles: selectedFiles.length,
        totalFolders: selectedFolders.length,
        totalBytes: selectedBytes,
        status: 'running',
        startedAt: new Date()
      }
    })

    // Enqueue transfer job
    await migrationQueue.enqueue(migrationId, 'transfer', async (signal, isPaused) => {
      try {
        const result = await transferService.executeMigration(
          migrationId,
          userId,
          signal,
          isPaused
        )

        syncGoogleQuota(migration.targetAccountId).catch(() => undefined)

        emit(migrationId, {
          type: 'complete',
          data: {
            totalFiles: result.totalFiles,
            completedFiles: result.completedFiles,
            failedFiles: result.failedFiles,
            skippedFiles: result.skippedFiles
          }
        })

        setTimeout(() => { /* Redis subscription auto-cleans on unsubscribe */ }, 30_000)
      } catch (err) {
        console.error('[MIGRATION] transfer error:', err)
        throw err
      }
    })

    return migration
  }

  /**
   * Get dry-run quota check for migration
   */
  async getDryRun(migrationId: string, userId: string) {
    const migration = await prisma.migrationSession.findFirstOrThrow({
      where: { id: migrationId, userId, status: 'scanned' }
    })

    const selectedItems = await scanResultService.getSelectedItems(migrationId)

    const totalBytes = selectedItems.reduce((sum, i) => sum + BigInt(i.size), 0n)

    // Get available quota for target account
    const targetAccount = await prisma.connectedAccount.findUnique({
      where: { id: migration.targetAccountId },
      include: { storageAccount: true }
    })

    let availableBytes = 0n
    let hasEnoughSpace = false

    if (targetAccount?.storageAccount) {
      const total = targetAccount.storageAccount.totalBytes ?? 0n
      const used = targetAccount.storageAccount.usedBytes ?? 0n
      availableBytes = total - used
      hasEnoughSpace = availableBytes >= totalBytes
    }

    return {
      selectedCount: selectedItems.length,
      totalBytes: totalBytes.toString(),
      availableBytes: availableBytes.toString(),
      hasEnoughSpace,
      targetAccount: {
        email: targetAccount?.email,
        displayName: targetAccount?.displayName
      }
    }
  }
}

export const migrationService = new MigrationService()
