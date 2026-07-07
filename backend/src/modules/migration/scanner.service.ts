import { google } from 'googleapis'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient, createOAuthClient } from '../google/google.service.js'
import { crawlDriveFiles, type CrawlCursor } from '../google/drive-scanner.js'
import { emit } from './migration.service.js'

export interface ScanProgress {
  migrationId: string
  files: number
  folders: number
  pages: number
  bytes: number
  currentFolder: string
  [key: string]: unknown
}

export interface ScanItem {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  isFolder: boolean
  isGoogleWorkspace: boolean
  parents: string[]
  modifiedTime?: string | null
}

export interface ScanCompleteData {
  migrationId: string
  sourceAccount: { email: string; displayName: string | null }
  totalFiles: number
  totalFolders: number
  skippedFiles: number
  totalBytes: string
  extensionBreakdown: Array<{ extension: string; count: number; bytes: number }>
  warnings: string[]
  timedOut: boolean
  [key: string]: unknown
}

export class ScannerService {
  /**
   * Start scanning a Google Drive account
   * Returns SSE event handlers for real-time progress
   */
  async startScan(
    sourceAccountId: string,
    userId: string,
    callbacks: {
      onStatus: (phase: string, message: string, migrationId?: string) => void
      onProgress: (progress: ScanProgress) => void
      onItemsFound: (items: ScanItem[]) => void
      onComplete: (data: ScanCompleteData) => void
      onError: (message: string) => void
    }
  ): Promise<void> {
    try {
      // Find source account
      const account = await prisma.connectedAccount.findFirstOrThrow({
        where: {
          id: sourceAccountId,
          userId,
          provider: 'google_drive',
          status: { in: ['connected', 'migration_source'] }
        }
      })

      // Check for existing scan
      const existingScan = await prisma.migrationSession.findFirst({
        where: { userId, sourceAccountId, status: { in: ['scanned', 'running', 'paused'] } }
      })

      if (existingScan) {
        const itemCount = await prisma.migrationItem.count({
          where: { migrationId: existingScan.id }
        })
        callbacks.onStatus('existing', 'Scan already exists', existingScan.id)
        callbacks.onComplete({
          migrationId: existingScan.id,
          sourceAccount: { email: account.email, displayName: account.displayName },
          totalFiles: existingScan.totalFiles,
          totalFolders: existingScan.totalFolders,
          skippedFiles: existingScan.skippedFiles,
          totalBytes: existingScan.totalBytes.toString(),
          extensionBreakdown: [],
          warnings: [],
          timedOut: false
        })
        return
      }

      // Check for stuck scanning sessions
      const scanningSession = await prisma.migrationSession.findFirst({
        where: { userId, sourceAccountId, status: 'scanning' },
        orderBy: { createdAt: 'desc' }
      })

      if (scanningSession) {
        const age = Date.now() - new Date(scanningSession.createdAt).getTime()
        if (age > 60_000) {
          await prisma.migrationSession.update({
            where: { id: scanningSession.id },
            data: { status: 'failed', errorMessage: 'Scan timed out', completedAt: new Date() }
          })
        } else {
          callbacks.onStatus('already_scanning', 'Scan already in progress', scanningSession.id)
          return
        }
      }

      // Find default target account
      const defaultTarget = await prisma.connectedAccount.findFirst({
        where: { userId, provider: { in: ['google_drive', 's3'] }, status: 'connected' },
        orderBy: { createdAt: 'asc' }
      })

      // Check for resumable session
      const resumableSession = await prisma.migrationSession.findFirst({
        where: { userId, sourceAccountId, status: { in: ['failed', 'cancelled'] } },
        orderBy: { updatedAt: 'desc' }
      })

      let migration: { id: string }
      let cursor: CrawlCursor | undefined
      let isResume = false

      if (resumableSession) {
        cursor = (resumableSession.cursor as CrawlCursor) ?? undefined
        isResume = !!cursor?.fullyScannedFolderIds?.length

        migration = await prisma.migrationSession.update({
          where: { id: resumableSession.id },
          data: {
            status: 'scanning',
            totalFiles: 0,
            totalFolders: 0,
            completedFiles: 0,
            failedFiles: 0,
            skippedFiles: 0,
            totalBytes: 0n,
            migratedBytes: 0n,
            errorMessage: null,
            completedAt: null
          }
        })
      } else {
        migration = await prisma.migrationSession.create({
          data: {
            userId,
            sourceAccountId: account.id,
            targetAccountId: defaultTarget?.id ?? account.id,
            status: 'scanning'
          }
        })
      }

      callbacks.onStatus(
        'starting',
        isResume ? 'Resuming scan from last position...' : 'Connecting to Google Drive...',
        migration.id
      )

      // Get authenticated Google client
      const auth = await getAuthedGoogleClient(account)
      const drive = google.drive({ version: 'v3', auth })

      callbacks.onStatus(
        'scanning',
        isResume ? 'Resuming scan...' : 'Scanning files...',
        migration.id
      )

      let totalFilesCount = 0
      let totalFoldersCount = 0
      let totalSkippedCount = 0
      const fullyScannedFolderIds: string[] = [...(cursor?.fullyScannedFolderIds ?? [])]

      // Start crawling
      const crawlResult = await crawlDriveFiles(
        drive,
        undefined,
        {
          onProgress: (progress) => {
            callbacks.onProgress({
              migrationId: migration.id,
              ...progress
            })

            // Save cursor progress periodically
            prisma.migrationSession.update({
              where: { id: migration.id },
              data: { cursor: { fullyScannedFolderIds, lastProgressPath: progress.currentFolder } }
            }).catch(() => undefined)
          },
          onItemsFound: async (items) => {
            const dbItems = items.map((item) => ({
              migrationId: migration.id,
              sourceFileId: item.id,
              sourceParentId: item.parents[0] ?? null,
              name: item.name,
              mimeType: item.mimeType,
              sizeBytes: BigInt(item.size),
              isFolder: item.isFolder,
              status: item.isGoogleWorkspace ? 'skipped' : 'pending',
              modifiedTime: item.modifiedTime ? new Date(item.modifiedTime) : null
            }))

            // Skip items that already exist in DB
            const existingSourceIds = await prisma.migrationItem.findMany({
              where: {
                migrationId: migration.id,
                sourceFileId: { in: dbItems.map((i) => i.sourceFileId) }
              },
              select: { sourceFileId: true }
            })
            const existingIds = new Set(existingSourceIds.map((i) => i.sourceFileId))
            const newItems = dbItems.filter((i) => !existingIds.has(i.sourceFileId))

            if (newItems.length > 0) {
              await prisma.migrationItem.createMany({ data: newItems })
            }

            // Backfill modifiedTime for existing items
            const existingItemsToBackfill = dbItems.filter(
              (i) => existingIds.has(i.sourceFileId) && i.modifiedTime
            )
            for (const item of existingItemsToBackfill) {
              await prisma.migrationItem.updateMany({
                where: {
                  migrationId: migration.id,
                  sourceFileId: item.sourceFileId,
                  modifiedTime: null
                },
                data: { modifiedTime: item.modifiedTime }
              })
            }

            // Count items
            let batchFiles = 0
            let batchFolders = 0
            let batchSkipped = 0
            let batchBytes = 0n

            for (const item of items) {
              if (!existingIds.has(item.id)) {
                if (item.isFolder) batchFolders++
                else if (item.isGoogleWorkspace) batchSkipped++
                else {
                  batchFiles++
                  batchBytes += BigInt(item.size)
                }
              }
            }

            totalFilesCount += batchFiles
            totalFoldersCount += batchFolders
            totalSkippedCount += batchSkipped

            if (batchFiles > 0 || batchFolders > 0 || batchSkipped > 0) {
              await prisma.migrationSession.update({
                where: { id: migration.id },
                data: {
                  totalFiles: totalFilesCount,
                  totalFolders: totalFoldersCount,
                  skippedFiles: totalSkippedCount,
                  totalBytes: { increment: batchBytes }
                }
              })
            }

            callbacks.onItemsFound(
              items.map((i) => ({
                id: i.id,
                name: i.name,
                mimeType: i.mimeType,
                sizeBytes: i.size,
                isFolder: i.isFolder,
                isGoogleWorkspace: i.isGoogleWorkspace,
                parents: i.parents,
                modifiedTime: i.modifiedTime
              }))
            )
          },
          onFolderComplete: async (folderId) => {
            fullyScannedFolderIds.push(folderId)
            await prisma.migrationSession.update({
              where: { id: migration.id },
              data: { cursor: { fullyScannedFolderIds, lastProgressPath: null } }
            }).catch(() => undefined)
          }
        },
        `/home/${account.email}`,
        cursor
      )

      const { items: crawled, warnings, timedOut } = crawlResult
      const totalBytes = crawled
        .filter((i) => !i.isFolder)
        .reduce((sum, f) => sum + BigInt(f.size), 0n)

      // Update final status
      await prisma.migrationSession.update({
        where: { id: migration.id },
        data: {
          totalFiles: totalFilesCount,
          totalFolders: totalFoldersCount,
          skippedFiles: totalSkippedCount,
          totalBytes,
          status: timedOut ? 'failed' : 'scanned',
          errorMessage: timedOut ? `Scan timed out. ${warnings.join('; ')}` : null
        }
      })

      // Calculate extension breakdown
      const byExtension: Record<string, { count: number; bytes: number }> = {}
      for (const file of crawled.filter((i) => !i.isFolder && !i.isGoogleWorkspace)) {
        const lastDot = file.name.lastIndexOf('.')
        const ext =
          lastDot > 0 && lastDot < file.name.length - 1
            ? file.name.slice(lastDot + 1).toLowerCase()
            : 'other'
        if (!byExtension[ext]) byExtension[ext] = { count: 0, bytes: 0 }
        byExtension[ext].count += 1
        byExtension[ext].bytes += file.size
      }

      const extensionBreakdown = Object.entries(byExtension)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([ext, data]) => ({ extension: ext, count: data.count, bytes: data.bytes }))

      callbacks.onComplete({
        migrationId: migration.id,
        sourceAccount: { email: account.email, displayName: account.displayName },
        totalFiles: totalFilesCount,
        totalFolders: totalFoldersCount,
        skippedFiles: totalSkippedCount,
        totalBytes: totalBytes.toString(),
        extensionBreakdown,
        warnings,
        timedOut
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Scan failed'
      callbacks.onError(msg)
    }
  }

  /**
   * Check if a scan already exists for a source account
   */
  async checkExistingScan(
    sourceAccountId: string,
    userId: string
  ): Promise<{
    exists: boolean
    migrationId?: string
    status?: string
    totalFiles?: number
    totalFolders?: number
    skippedFiles?: number
    totalBytes?: string
    itemCount?: number
    selectedCount?: number
  }> {
    const migration = await prisma.migrationSession.findFirst({
      where: {
        userId,
        sourceAccountId,
        status: { in: ['scanned', 'running', 'paused'] }
      }
    })

    if (!migration) {
      return { exists: false }
    }

    const itemCount = await prisma.migrationItem.count({
      where: { migrationId: migration.id }
    })

    const selectedCount = await prisma.migrationItem.count({
      where: { migrationId: migration.id, status: 'selected' }
    })

    return {
      exists: true,
      migrationId: migration.id,
      status: migration.status,
      totalFiles: migration.totalFiles,
      totalFolders: migration.totalFolders,
      skippedFiles: migration.skippedFiles,
      totalBytes: migration.totalBytes.toString(),
      itemCount,
      selectedCount
    }
  }

  /**
   * Get list of migration sources for a user
   */
  async getSources(userId: string) {
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId, provider: 'google_drive', status: 'migration_source' },
      orderBy: { createdAt: 'desc' }
    })

    return accounts.map((a) => ({
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      avatarUrl: a.avatarUrl
    }))
  }

  /**
   * Generate OAuth URL for connecting a migration source
   */
  async getSourceConnectUrl(userId: string): Promise<string> {
    const config = await prisma.providerConfig.findFirstOrThrow({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' }
    })

    const state = randomToken()
    await prisma.oauthState.create({
      data: {
        userId,
        providerConfigId: config.id,
        flow: 'migration_source',
        stateHash: hashToken(state),
        expiresAt: new Date(Date.now() + 10 * 60_000)
      }
    })

    const client = createOAuthClient(config)
    const backendOrigin = env.FRONTEND_URL
    const callbackUrl = `${backendOrigin}/api/migrations/source/callback`

    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: config.scopes as string[],
      state,
      redirect_uri: callbackUrl
    })
  }

  /**
   * Remove a migration source
   */
  async removeSource(accountId: string, userId: string): Promise<void> {
    await prisma.connectedAccount.updateMany({
      where: { id: accountId, userId, status: 'migration_source' },
      data: { status: 'disconnected' }
    })
  }
}

export const scannerService = new ScannerService()

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hashToken(token: string): string {
  return token
}
