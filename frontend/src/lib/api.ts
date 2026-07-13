import { clearAuthSession, getAccessToken, getRefreshToken, setAccessToken } from '@/lib/auth'

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

type ApiOptions = RequestInit & { skipAuth?: boolean; retry?: boolean }

async function refreshAccessToken() {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return false
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!response.ok) return false
  const data = await response.json() as { accessToken: string }
  setAccessToken(data.accessToken)
  return true
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  const token = getAccessToken()
  if (!options.skipAuth && token) headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const response = await fetch(`${API_URL}${path}`, { ...options, headers })
  if (response.status === 401 && options.retry !== false && !options.skipAuth && await refreshAccessToken()) {
    return apiFetch<T>(path, { ...options, retry: false })
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }))
    if (response.status === 401) clearAuthSession()
    throw new Error(error.message ?? 'Request failed')
  }

  return response.json() as Promise<T>
}

export function formatBytes(input: string | number | bigint | null | undefined) {
  if (input === null || input === undefined) return '--'
  const bytes = Number(input)
  if (!Number.isFinite(bytes)) return '--'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export type Migration = {
  id: string
  status: string
  totalFiles: number
  totalFolders: number
  completedFiles: number
  failedFiles: number
  skippedFiles: number
  totalBytes: string
  migratedBytes: string
  percentComplete: number
  errorMessage?: string | null
  startedAt?: string | null
  completedAt?: string | null
  createdAt: string
  sourceAccountId: string
  sourceAccount: { email: string; displayName?: string | null }
  targetAccount: { email: string; displayName?: string | null }
}

export type MigrationItem = {
  id: string
  sourceFileId: string
  name: string
  mimeType: string
  sizeBytes: string
  isFolder: boolean
  status: string
  errorMessage?: string | null
  retryCount: number
}

export function streamScan(sourceAccountId: string, onEvent: (event: { type: string; data: Record<string, unknown> }) => void, force = false): EventSource {
  const token = getAccessToken()
  const params = new URLSearchParams()
  if (token) params.set('token', token)
  if (force) params.set('force', 'true')
  const qs = params.toString()
  const url = `${API_URL}/migrations/scan/${sourceAccountId}/stream${qs ? `?${qs}` : ''}`
  const es = new EventSource(url)
  let completed = false

  es.addEventListener('status', (e) => { onEvent({ type: 'status', data: JSON.parse(e.data) }) })
  es.addEventListener('progress', (e) => { onEvent({ type: 'progress', data: JSON.parse(e.data) }) })
  es.addEventListener('items-found', (e) => { onEvent({ type: 'items-found', data: JSON.parse(e.data) }) })
  es.addEventListener('complete', (e) => {
    completed = true
    onEvent({ type: 'complete', data: JSON.parse(e.data) })
    es.close()
  })
  es.addEventListener('error', (e: MessageEvent) => {
    if (completed) return
    if (es.readyState === EventSource.CLOSED) {
      onEvent({ type: 'error', data: { message: 'Connection lost' } })
      return
    }
    try { onEvent({ type: 'error', data: JSON.parse(e.data) }) } catch { onEvent({ type: 'error', data: { message: 'Connection lost' } }) }
  })

  return es
}

export type BrowseItem = {
  id: string
  sourceFileId: string
  sourceParentId: string | null
  name: string
  mimeType: string
  sizeBytes: string
  isFolder: boolean
  status: string
  errorMessage?: string | null
  modifiedTime?: string | null
  createdAt?: string
}

export async function browseMigrationItems(migrationId: string, params: { parentId?: string; type?: string; ext?: string; page?: number; limit?: number; search?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.parentId) qs.set('parentId', params.parentId)
  if (params.type) qs.set('type', params.type)
  if (params.ext) qs.set('ext', params.ext)
  if (params.page) qs.set('page', String(params.page))
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.search) qs.set('search', params.search)
  return apiFetch<{ items: BrowseItem[]; total: number; page: number; limit: number; totalPages: number; selectedCount: number; selectedBytes: string }>(`/migrations/${migrationId}/browse?${qs}`)
}

export async function selectMigrationItems(migrationId: string, body: { itemIds?: string[]; selectAll?: boolean }) {
  return apiFetch<{ selectedCount: number; selectedBytes: string }>(`/migrations/${migrationId}/items/select`, { method: 'PATCH', body: JSON.stringify(body) })
}

export async function deselectMigrationItems(migrationId: string, body: { itemIds?: string[]; deselectAll?: boolean }) {
  return apiFetch<{ selectedCount: number; selectedBytes: string }>(`/migrations/${migrationId}/items/deselect`, { method: 'PATCH', body: JSON.stringify(body) })
}

export async function startMigrationSelected(migrationId: string) {
  return apiFetch<{ status: string; message: string }>(`/migrations/${migrationId}/start`, { method: 'POST' })
}

export async function getMigrations() {
  return apiFetch<{ migrations: Migration[] }>('/migrations')
}

export async function getMigration(id: string) {
  return apiFetch<{ migration: Migration }>(`/migrations/${id}`)
}

export async function pauseMigration(id: string) {
  return apiFetch(`/migrations/${id}/pause`, { method: 'POST' })
}

export async function resumeMigration(id: string) {
  return apiFetch(`/migrations/${id}/resume`, { method: 'POST' })
}

export async function cancelMigration(id: string) {
  return apiFetch(`/migrations/${id}`, { method: 'DELETE' })
}

export async function getMigrationItems(id: string, page = 1, limit = 50) {
  return apiFetch<{ items: MigrationItem[]; total: number; page: number; limit: number; totalPages: number }>(`/migrations/${id}/items?page=${page}&limit=${limit}`)
}

export async function retryFailedMigration(id: string) {
  return apiFetch(`/migrations/${id}/retry-failed`, { method: 'POST' })
}

export function streamMigration(id: string, onEvent: (event: { type: string; data: Record<string, unknown> }) => void): EventSource {
  const url = `${API_URL}/migrations/${id}/stream`
  const es = new EventSource(url, { withCredentials: false })

  es.addEventListener('progress', (e) => onEvent({ type: 'progress', data: JSON.parse(e.data) }))
  es.addEventListener('item-complete', (e) => onEvent({ type: 'item-complete', data: JSON.parse(e.data) }))
  es.addEventListener('item-failed', (e) => onEvent({ type: 'item-failed', data: JSON.parse(e.data) }))
  es.addEventListener('complete', (e) => onEvent({ type: 'complete', data: JSON.parse(e.data) }))
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED) return
    onEvent({ type: 'error', data: { message: 'Connection lost' } })
  })

  return es
}

export type MigrationSource = { id: string; email: string; displayName?: string | null; avatarUrl?: string | null }

export async function getMigrationSources() {
  return apiFetch<{ sources: MigrationSource[] }>('/migrations/sources')
}

export async function getMigrationSourceConnectUrl() {
  return apiFetch<{ url: string }>('/migrations/source/connect-url')
}

export async function deleteMigrationSource(id: string) {
  return apiFetch(`/migrations/sources/${id}`, { method: 'DELETE' })
}

export type ScanStatus = {
  exists: boolean
  migrationId?: string
  status?: string
  totalFiles?: number
  totalFolders?: number
  skippedFiles?: number
  totalBytes?: string
  itemCount?: number
  selectedCount?: number
}

export async function checkScanStatus(sourceAccountId: string) {
  return apiFetch<ScanStatus>(`/migrations/scan/${sourceAccountId}/status`)
}

export async function deleteMigrations(migrationIds: string[]) {
  return apiFetch<{ status: string; message: string }>('/migrations/batch', { method: 'DELETE', body: JSON.stringify({ migrationIds }) })
}

export async function getMigrationDryRun(migrationId: string) {
  return apiFetch<{
    selectedCount: number
    totalBytes: string
    availableBytes: string
    hasEnoughSpace: boolean
    targetAccount: { email?: string; displayName?: string | null }
  }>(`/migrations/${migrationId}/dry-run`, { method: 'POST' })
}

export async function getMigrationJobs(migrationId: string) {
  return apiFetch<{
    jobs: Array<{
      id: string
      type: string
      status: string
      retryCount: number
      maxRetries: number
      errorMessage?: string | null
      startedAt?: string | null
      completedAt?: string | null
      createdAt: string
    }>
  }>(`/migrations/${migrationId}/jobs`)
}

export async function retryMigrationJobs(migrationId: string) {
  return apiFetch<{ status: string; message: string }>(`/migrations/${migrationId}/jobs/retry`, { method: 'POST' })
}
