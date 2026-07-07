import { google } from 'googleapis'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient, ensureGoogleAppFolder, syncGoogleQuota } from '../google/google.service.js'
import { migrateFile } from './file-migrator.js'
import { migrationQueue } from './migration-queue-db.js'
import { transferService } from './transfer.service.js'
import { selectAccount } from '../uploads/upload.routes.js'

export type MigrationEvent =
  | { type: 'progress'; data: { completedFiles: number; failedFiles: number; skippedFiles: number; currentFile?: string; percentComplete: number } }
  | { type: 'item-complete'; data: { itemId: string; name: string; status: string } }
  | { type: 'item-failed'; data: { itemId: string; name: string; error: string } }
  | { type: 'complete'; data: { totalFiles: number; completedFiles: number; failedFiles: number; skippedFiles: number } }
  | { type: 'error'; data: { message: string } }

type Subscriber = (event: MigrationEvent) => void

const subscribers = new Map<string, Set<Subscriber>>()

export function emit(migrationId: string, event: MigrationEvent) {
  const subs = subscribers.get(migrationId)
  if (subs) {
    for (const cb of subs) {
      try { cb(event) } catch { /* ignore */ }
    }
  }
}

export function subscribeMigration(migrationId: string, callback: Subscriber): () => void {
  if (!subscribers.has(migrationId)) subscribers.set(migrationId, new Set())
  subscribers.get(migrationId)!.add(callback)
  return () => {
    const subs = subscribers.get(migrationId)
    if (subs) {
      subs.delete(callback)
      if (subs.size === 0) subscribers.delete(migrationId)
    }
  }
}

export class MigrationService {
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
        ? Math.round(
            ((migration.completedFiles + migration.failedFiles + migration.skippedFiles) /
              migration.totalFiles) *
              100
          )
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
          ? Math.round(((m.completedFiles + m.failedFiles + m.skippedFiles) / m.totalFiles) * 100)
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

    const skip = (page - 1) * limit
    const [items, total] = await Promise.all([
      prisma.migrationItem.findMany({
        where: { migrationId },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit
      }),
      prisma.migrationItem.count({ where: { migrationId } })
    ])

    return {
      items: items.map((i) => ({ ...i, sizeBytes: i.sizeBytes.toString() })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
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
        status: { in: ['completed', 'failed'] }
      }
    })

    // Reset failed items to selected
    await prisma.migrationItem.updateMany({
      where: { migrationId, status: 'failed' },
      data: { status: 'selected', errorMessage: null, retryCount: 0 }
    })

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

      setTimeout(() => subscribers.delete(migrationId), 30_000)
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

    const selectedItems = await prisma.migrationItem.findMany({
      where: { migrationId, status: 'selected' }
    })

    if (selectedItems.length === 0) {
      throw Object.assign(new Error('No items selected.'), { status: 400 })
    }

    const selectedBytes = selectedItems.reduce((sum, i) => sum + i.sizeBytes, 0n)

    // Auto-select ancestor folders
    const ancestorIds = new Set<string>()
    for (const item of selectedItems) {
      let parentId = item.sourceParentId
      while (parentId) {
        if (ancestorIds.has(parentId)) break
        ancestorIds.add(parentId)
        const parent = await prisma.migrationItem.findFirst({
          where: { migrationId, sourceFileId: parentId }
        })
        parentId = parent?.sourceParentId ?? null
      }
    }

    if (ancestorIds.size > 0) {
      await prisma.migrationItem.updateMany({
        where: {
          migrationId,
          sourceFileId: { in: Array.from(ancestorIds) },
          isFolder: true,
          status: 'pending'
        },
        data: { status: 'selected' }
      })
    }

    // Count final selection
    const allSelected = await prisma.migrationItem.findMany({
      where: { migrationId, status: 'selected' }
    })
    const selectedFolders = allSelected.filter((i) => i.isFolder)
    const selectedFiles = allSelected.filter((i) => !i.isFolder)

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

      setTimeout(() => subscribers.delete(migrationId), 30_000)
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

    const selectedItems = await prisma.migrationItem.findMany({
      where: { migrationId, status: 'selected' }
    })

    const totalBytes = selectedItems.reduce((sum, i) => sum + i.sizeBytes, 0n)

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
