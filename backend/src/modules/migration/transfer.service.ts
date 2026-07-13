import { google } from 'googleapis'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient, ensureGoogleAppFolder, syncGoogleQuota } from '../google/google.service.js'
import { migrateFile } from './file-migrator.js'
import { emit } from './migration.service.js'
import { scanResultService } from '../mongodb/scan-result.service.js'
import type { ConnectedAccount } from '@prisma/client'

export interface TransferProgress {
  completedFiles: number
  failedFiles: number
  skippedFiles: number
  currentFile: string
  percentComplete: number
}

export interface TransferResult {
  totalFiles: number
  completedFiles: number
  failedFiles: number
  skippedFiles: number
  migratedBytes: bigint
}

export class TransferService {
  /**
   * Execute migration for selected items
   * Handles folder creation, file transfer, and progress tracking
   */
  async executeMigration(
    migrationId: string,
    userId: string,
    signal: AbortSignal,
    isPaused: () => boolean
  ): Promise<TransferResult> {
    const migration = await prisma.migrationSession.findUniqueOrThrow({
      where: { id: migrationId }
    })

    const sourceAccount = await prisma.connectedAccount.findUniqueOrThrow({
      where: { id: migration.sourceAccountId }
    })

    const sourceAuth = await getAuthedGoogleClient(sourceAccount)
    const sourceDrive = google.drive({ version: 'v3', auth: sourceAuth })

    // Get all selected items from MongoDB
    const allSelected = await scanResultService.getSelectedItems(migrationId)

    const folderItems = allSelected.filter((i) => i.type === 'folder') as Array<{
      sourceFileId: string
      sourceParentId: string | null
      name: string
    }>
    const fileItems = allSelected.filter((i) => i.type === 'file') as Array<{
      sourceFileId: string
      sourceParentId: string | null
      name: string
      size: number | bigint
      mimeType: string
    }>

    // Map source folder IDs to created virtual folder IDs
    const sourceIdToFolderId = new Map<string, string>()
    const folderAccount = await prisma.connectedAccount.findFirst({
      where: {
        userId: migration.userId,
        provider: { in: ['google_drive', 's3'] },
        status: 'connected'
      },
      orderBy: { createdAt: 'asc' }
    })

    // Phase 1: Create folders
    await this.createFolders(
      migrationId,
      folderItems,
      migration.userId,
      folderAccount?.id ?? null,
      sourceIdToFolderId,
      signal,
      isPaused
    )

    // Phase 2: Transfer files
    let completedFiles = 0
    let failedFiles = 0
    let migratedBytes = 0n
    const skippedItems = await scanResultService.getByMigration(migrationId, { status: 'skipped' })
    const skippedList = skippedItems.items as Array<{
      sourceFileId: string
      name: string
    }>
    const reservedBytesByAccount = new Map<string, bigint>()

    for (const item of fileItems) {
      if (signal.aborted) break
      await this.waitForResume(isPaused, signal)
      if (signal.aborted) break

      try {
        const parentSourceId = item.sourceParentId
        const virtualFolderId = parentSourceId
          ? sourceIdToFolderId.get(parentSourceId) ?? null
          : null

        // Skip if file already exists
        const existing = await prisma.file.findFirst({
          where: {
            userId: migration.userId,
            name: item.name,
            folderId: virtualFolderId,
            status: 'active'
          }
        })

        if (existing) {
          await scanResultService.updateStatusBySourceFileId(migrationId, item.sourceFileId, 'skipped', { targetFileId: existing.id })
          await prisma.migrationSession.update({
            where: { id: migrationId },
            data: { skippedFiles: { increment: 1 } }
          })
          continue
        }

        // Emit progress
        emit(migrationId, {
          type: 'progress',
          data: {
            completedFiles,
            failedFiles,
            skippedFiles: skippedList.length,
            currentFile: item.name,
            percentComplete:
              fileItems.length > 0
                ? Math.round(((completedFiles + failedFiles) / fileItems.length) * 100)
                : 0
          }
        })

        // Select target account with enough space
        const targetAccount = await this.selectAccount(
          migration.userId,
          BigInt(item.size),
          reservedBytesByAccount
        )

        if (!targetAccount) {
          throw new Error('No connected storage account has enough space for this file.')
        }

        reservedBytesByAccount.set(
          targetAccount.id,
          (reservedBytesByAccount.get(targetAccount.id) ?? 0n) + BigInt(item.size)
        )

        const targetAuth = await getAuthedGoogleClient(targetAccount)
        const targetDrive = google.drive({ version: 'v3', auth: targetAuth })
        const targetAppFolderId = await ensureGoogleAppFolder(targetAccount as any)

        const { providerFileId, checksum } = await this.transferFile(
          sourceDrive,
          targetDrive,
          item.sourceFileId,
          targetAppFolderId,
          item.name,
          item.mimeType,
          signal
        )

        // Validate checksum
        const itemData = await scanResultService.getBySourceFileId(migrationId, item.sourceFileId)
        if (itemData?.checksum && itemData.checksum !== checksum) {
          throw new Error(`Checksum mismatch for file ${item.name}`)
        }

        // Create file record
        const file = await prisma.file.create({
          data: {
            userId: migration.userId,
            connectedAccountId: targetAccount.id,
            folderId: virtualFolderId,
            provider: 'google_drive',
            providerFileId,
            name: item.name,
            mimeType: item.mimeType,
            sizeBytes: BigInt(item.size),
            checksum
          }
        })

        await scanResultService.updateStatusBySourceFileId(migrationId, item.sourceFileId, 'completed', {
          targetFileId: file.id,
          checksum
        })

        completedFiles += 1
        migratedBytes += BigInt(item.size)

        await prisma.migrationSession.update({
          where: { id: migrationId },
          data: { completedFiles, migratedBytes }
        })

        emit(migrationId, {
          type: 'item-complete',
          data: { itemId: item.sourceFileId, name: item.name, status: 'completed' }
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'File migration failed'
        await scanResultService.updateStatusBySourceFileId(migrationId, item.sourceFileId, 'failed', { errorMessage: msg, retryCount: 0 })
        failedFiles += 1
        await prisma.migrationSession.update({
          where: { id: migrationId },
          data: { failedFiles }
        })
        emit(migrationId, {
          type: 'item-failed',
          data: { itemId: item.sourceFileId, name: item.name, error: msg }
        })
      }
    }

    // Update final status
    const processed = completedFiles + failedFiles + skippedList.length
    if (processed > fileItems.length) {
      console.error('[MIGRATION] Invalid counter detected:', { totalFiles: fileItems.length, completedFiles, failedFiles, skippedFiles: skippedList.length })
    }

    const finalStatus = signal.aborted
      ? 'cancelled'
      : failedFiles > 0
        ? 'completed_with_errors'
        : 'completed'

    await tx.migrationSession.update({
      where: { id: migrationId },
      data: {
        status: finalStatus,
        completedAt: new Date()
      }
    })

    // Unlock accounts
    await tx.connectedAccount.updateMany({
      where: { id: { in: [migration.sourceAccountId, migration.targetAccountId] } },
      data: { lockedAt: null }
    })

    return {
      totalFiles: fileItems.length,
      completedFiles,
      failedFiles,
      skippedFiles: skippedList.length,
      migratedBytes
    }
  } catch (error) {
    // Rollback: unlock accounts and mark migration as failed
    await prisma.$executeRaw`ROLLBACK`
    await prisma.connectedAccount.updateMany({
      where: { id: { in: [migration.sourceAccountId, migration.targetAccountId] } },
      data: { lockedAt: null }
    })
    await prisma.migrationSession.update({
      where: { id: migrationId },
      data: {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Migration failed',
        completedAt: new Date()
      }
    })
    throw error
  }
  }

  /**
   * Create virtual folders in database
   */
  private async createFolders(
    migrationId: string,
    folderItems: Array<{
      sourceFileId: string
      sourceParentId: string | null
      name: string
    }>,
    userId: string,
    folderAccountId: string | null,
    sourceIdToFolderId: Map<string, string>,
    signal: AbortSignal,
    isPaused: () => boolean
  ): Promise<void> {
    for (const item of folderItems) {
      if (signal.aborted) return
      await this.waitForResume(isPaused, signal)
      if (signal.aborted) return

      try {
        const parentSourceId = item.sourceParentId
        const parentId = parentSourceId
          ? sourceIdToFolderId.get(parentSourceId) ?? null
          : null

        // Check if folder already exists
        const existing = await prisma.folder.findFirst({
          where: {
            userId,
            name: item.name,
            parentId,
            deletedAt: null
          }
        })

        let folderId: string
        if (existing) {
          folderId = existing.id
        } else {
          const folder = await prisma.folder.create({
            data: {
              userId,
              connectedAccountId: folderAccountId,
              provider: 'google_drive',
              name: item.name,
              parentId,
              color: '#3b82f6',
              iconUrl: 'https://api.iconify.design/lucide:folder.svg'
            }
          })
          folderId = folder.id
        }

        sourceIdToFolderId.set(item.sourceFileId, folderId)
        await scanResultService.updateStatusBySourceFileId(migrationId, item.sourceFileId, 'completed', { targetFolderId: folderId })
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Folder creation failed'
        await scanResultService.updateStatusBySourceFileId(migrationId, item.sourceFileId, 'failed', { errorMessage: msg })
      }
    }
  }

  /**
   * Transfer file from source to target Google Drive
   * Implements exponential backoff for rate limits
   */
  private async transferFile(
    sourceDrive: any,
    targetDrive: any,
    sourceFileId: string,
    targetFolderId: string,
    fileName: string,
    mimeType: string,
    signal: AbortSignal,
    maxRetries = 3
  ): Promise<string> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (signal.aborted) {
        throw new Error('Migration cancelled')
      }

      try {
        const fileId = await migrateFile(
          sourceDrive,
          targetDrive,
          sourceFileId,
          targetFolderId,
          fileName,
          mimeType
        )
        return fileId
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error')

        // Check if it's a rate limit error (429)
        if (lastError.message.includes('429') || lastError.message.includes('rate limit')) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }

        // For other errors, throw immediately
        throw lastError
      }
    }

    throw lastError || new Error('Max retries exceeded')
  }

  /**
   * Select target account with enough available space
   */
  private async selectAccount(
    userId: string,
    requiredBytes: bigint,
    reservedBytesByAccount: Map<string, bigint>
  ): Promise<ConnectedAccount | null> {
    const accounts = await prisma.connectedAccount.findMany({
      where: {
        userId,
        provider: { in: ['google_drive', 's3'] },
        status: 'connected'
      },
      include: {
        storageAccount: true
      },
      orderBy: { createdAt: 'asc' }
    })

    for (const account of accounts) {
      if (!account.storageAccount) continue

      const totalBytes = account.storageAccount.totalBytes ?? 0n
      const usedBytes = account.storageAccount.usedBytes ?? 0n
      const reserved = reservedBytesByAccount.get(account.id) ?? 0n
      const available = totalBytes - usedBytes - reserved

      if (available >= requiredBytes) {
        return account
      }
    }

    return null
  }

  /**
   * Ensure Google Drive app folder exists for account
   */
  private async ensureGoogleAppFolder(account: { id: string }): Promise<string> {
    // Simplified - in production, check/create the 9drive folder
    return account.id
  }

  /**
   * Wait while paused, respecting abort signal
   */
  private async waitForResume(
    isPaused: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    return new Promise((resolve) => {
      if (!isPaused()) {
        resolve()
        return
      }

      const interval = setInterval(() => {
        if (!isPaused() || signal.aborted) {
          clearInterval(interval)
          resolve()
        }
      }, 500)
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
}

export const transferService = new TransferService()
