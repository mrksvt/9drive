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

const MAX_DEPTH = 50
const API_TIMEOUT_MS = 30_000
const OVERALL_TIMEOUT_MS = 30 * 60_000

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
  const skipFolderIds = new Set(cursor?.fullyScannedFolderIds ?? [])
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

  async function crawlFolder(folderId: string | undefined, currentPath: string, depth: number) {
    if (depth > MAX_DEPTH) {
      warnings.push(`Max depth ${MAX_DEPTH} reached at ${currentPath}`)
      return
    }

    if (checkOverallTimeout()) return

    if (folderId && skipFolderIds.has(folderId)) {
      return
    }

    let pageToken: string | undefined
    const subfolders: drive_v3.Schema$File[] = []

    try {
      do {
        if (checkOverallTimeout()) return

        const parentQuery = folderId ? `'${folderId}' in parents` : `'root' in parents`
        const response = await withTimeout(
          drive.files.list({
            q: `${parentQuery} and trashed = false`,
            spaces: 'drive',
            fields: 'nextPageToken,files(id,name,mimeType,size,parents,modifiedTime)',
            pageSize: 1000,
            pageToken,
          }),
          API_TIMEOUT_MS,
          `API call at ${currentPath}`
        )

        for (const file of response.data.files ?? []) {
          if (!file.id || !file.name || !file.mimeType) continue
          if (seen.has(file.id)) continue
          seen.add(file.id)

          if (file.mimeType === googleDriveFolderMimeType) {
            subfolders.push(file)
          } else {
            const isGoogleWorkspace = GOOGLE_WORKSPACE_MIME_TYPES.has(file.mimeType)
            allItems.push({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              size: Number(file.size ?? 0),
              parents: (file.parents ?? []).filter((p): p is string => typeof p === 'string'),
              isFolder: false,
              isGoogleWorkspace,
              modifiedTime: file.modifiedTime ?? null,
            })
          }
        }

        pages++

        const pageItems = (response.data.files ?? [])
          .filter((f) => f.id && f.name && f.mimeType && seen.has(f.id))
          .map((f) => ({
            id: f.id!,
            name: f.name!,
            mimeType: f.mimeType!,
            size: Number(f.size ?? 0),
            parents: (f.parents ?? []).filter((p): p is string => typeof p === 'string'),
            isFolder: f.mimeType === googleDriveFolderMimeType,
            isGoogleWorkspace: GOOGLE_WORKSPACE_MIME_TYPES.has(f.mimeType!),
            modifiedTime: f.modifiedTime ?? null,
          }))
        if (callbacks.onItemsFound && pageItems.length > 0) await callbacks.onItemsFound(pageItems)

        emitProgress(currentPath)

        pageToken = response.data.nextPageToken ?? undefined
      } while (pageToken)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      warnings.push(`Error scanning ${currentPath}: ${errorMsg}`)
      emitProgress(currentPath)
    }

    subfolders.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))

    for (const folder of subfolders) {
      if (!folder.id || !folder.name) continue

      if (skipFolderIds.has(folder.id)) continue

      const subPath = `${currentPath}/${folder.name}`
      allItems.push({
        id: folder.id,
        name: folder.name,
        mimeType: googleDriveFolderMimeType,
        size: 0,
        parents: (folder.parents ?? []).filter((p): p is string => typeof p === 'string'),
        isFolder: true,
        isGoogleWorkspace: false,
        modifiedTime: folder.modifiedTime ?? null,
      })

      emitProgress(subPath)

      await crawlFolder(folder.id, subPath, depth + 1)

      if (timedOut) return
    }

    if (folderId && callbacks.onFolderComplete && !timedOut) {
      await callbacks.onFolderComplete(folderId)
    }
  }

  try {
    await withTimeout(
      crawlFolder(rootFolderId, rootPath, 0),
      OVERALL_TIMEOUT_MS,
      'Overall scan'
    )
  } catch (error) {
    timedOut = true
    const errorMsg = error instanceof Error ? error.message : String(error)
    warnings.push(`Scan failed: ${errorMsg}`)
  }

  return { items: allItems, warnings, timedOut }
}
