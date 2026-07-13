import { type drive_v3 } from 'googleapis'

export const googleDriveFolderMimeType = 'application/vnd.google-apps.folder'

const GOOGLE_WORKSPACE_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.drawing',
  'application/vnd.google-apps.map',
  'application/vnd.google-apps.site',
  'application/vnd.google-apps.script',
  'application/vnd.google-apps.fusiontable',
  'application/vnd.google-apps.shortcut',
])

const API_TIMEOUT_MS = 30_000
const OVERALL_TIMEOUT_MS = 60 * 60_000

export type CrawledItem = {
  id: string
  name: string
  mimeType: string
  size: number
  parents: string[]
  isFolder: boolean
  isGoogleWorkspace: boolean
  modifiedTime: string | null
}

export type CrawlProgress = {
  files: number
  folders: number
  skipped: number
  pages: number
  bytes: number
  currentFolder: string
  warnings: string[]
}

export type CrawlCursor = {
  fullyScannedFolderIds: string[]
  lastProgressPath: string | null
}

export type CrawlCallbacks = {
  onProgress?: (progress: CrawlProgress) => void
  onItemsFound?: (items: CrawledItem[]) => void | Promise<void>
  onFolderComplete?: (folderId: string) => void | Promise<void>
}

export type CrawlResult = {
  items: CrawledItem[]
  warnings: string[]
  timedOut: boolean
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ])
}

export async function crawlDriveFiles(
  drive: drive_v3.Drive,
  rootFolderId?: string,
  callbacks: CrawlCallbacks = {},
  rootPath = '/home/user',
  cursor?: CrawlCursor,
): Promise<CrawlResult> {
  const seen = new Set<string>()
  const allItems: CrawledItem[] = []
  const warnings: string[] = []
  let pages = 0
  let timedOut = false
  const startTime = Date.now()

  function checkOverallTimeout(): boolean {
    if (Date.now() - startTime > OVERALL_TIMEOUT_MS) {
      timedOut = true
      warnings.push(`Scan timed out after ${OVERALL_TIMEOUT_MS / 1000}s`)
      return true
    }
    return false
  }

  function emitProgress(currentPath: string) {
    if (callbacks.onProgress) {
      callbacks.onProgress({
        files: allItems.filter((i) => !i.isFolder && !i.isGoogleWorkspace).length,
        folders: allItems.filter((i) => i.isFolder).length,
        skipped: allItems.filter((i) => i.isGoogleWorkspace).length,
        pages,
        bytes: allItems.filter((i) => !i.isFolder).reduce((s, i) => s + i.size, 0),
        currentFolder: currentPath,
        warnings,
      })
    }
  }

  try {
    console.log(`[Scanner] Starting flat scan (all files, no parent filter)`)
    let pageToken: string | undefined

    do {
      if (checkOverallTimeout()) {
        console.warn(`[Scanner] Timeout during pagination at page ${pages}`)
        break
      }

      const response = await withTimeout(
        drive.files.list({
          q: 'trashed = false',
          spaces: 'drive',
          fields: 'nextPageToken,files(id,name,mimeType,size,parents,modifiedTime)',
          pageSize: 1000,
          pageToken,
        }),
        API_TIMEOUT_MS,
        `API call page ${pages}`
      )

      const files = response.data.files ?? []
      console.log(`[Scanner] Page ${pages}: ${files.length} items, nextPageToken=${!!response.data.nextPageToken}`)

      const pageItems: CrawledItem[] = []

      for (const file of files) {
        if (!file.id || !file.name || !file.mimeType) continue
        if (seen.has(file.id)) continue
        seen.add(file.id)

        const isFolder = file.mimeType === googleDriveFolderMimeType
        const isGoogleWorkspace = GOOGLE_WORKSPACE_MIME_TYPES.has(file.mimeType)
        const fileSize = Number(file.size ?? 0)

        const item: CrawledItem = {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: isFolder ? 0 : fileSize,
          parents: (file.parents ?? []).filter((p): p is string => typeof p === 'string'),
          isFolder,
          isGoogleWorkspace,
          modifiedTime: file.modifiedTime ?? null,
        }

        allItems.push(item)
        pageItems.push(item)
      }

      pages++

      if (callbacks.onItemsFound && pageItems.length > 0) {
        await callbacks.onItemsFound(pageItems)
      }

      emitProgress(`page ${pages}`)

      pageToken = response.data.nextPageToken ?? undefined
    } while (pageToken)

    if (callbacks.onFolderComplete) {
      for (const item of allItems.filter((i) => i.isFolder)) {
        await callbacks.onFolderComplete(item.id)
      }
    }
  } catch (error) {
    timedOut = true
    const errorMsg = error instanceof Error ? error.message : String(error)
    warnings.push(`Scan failed: ${errorMsg}`)
    console.error(`[Scanner] Scan failed: ${errorMsg}`)
  }

  const totalFiles = allItems.filter((i) => !i.isFolder && !i.isGoogleWorkspace).length
  const totalFolders = allItems.filter((i) => i.isFolder).length
  const totalBytes = allItems.filter((i) => !i.isFolder).reduce((s, i) => s + i.size, 0)
  console.log(`[Scanner] Scan complete: ${totalFiles} files, ${totalFolders} folders, ${totalBytes} bytes, timedOut=${timedOut}, elapsed=${Date.now() - startTime}ms`)

  return { items: allItems, warnings, timedOut }
}
