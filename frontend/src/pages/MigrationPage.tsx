import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowRightLeft, CheckCircle, ChevronRight, Grid3X3, LayoutList, Link2, Loader2, Pause, Play, RotateCcw, Scan, SearchIcon, Trash2, Users, X, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DummyModal } from '@/components/drive/DummyModal'
import { PageHeader } from '@/components/drive/PageHeader'
import { FileGrid } from '@/components/drive/FileGrid'
import { FileTable } from '@/components/drive/FileTable'
import { FolderGrid } from '@/components/drive/FolderGrid'
import { FolderVisual } from '@/components/drive/FolderVisual'
import { NetworkWarning, useNetworkGuard } from '@/components/drive/NetworkWarning'
import { browseMigrationItems, checkScanStatus, cancelMigration, deleteMigrationSource, deleteMigrations, deselectMigrationItems, formatDate, formatBytes, getMigration, getMigrationDryRun, getMigrationSourceConnectUrl, getMigrationSources, getMigrations, pauseMigration, resumeMigration, retryFailedMigration, selectMigrationItems, startMigrationSelected, streamMigration, streamScan, type BrowseItem, type Migration, type MigrationSource, type ScanStatus } from '@/lib/api'
import type { FileItem, FolderItem } from '@/data/drive-data'
import { cn } from '@/lib/utils'

function statusBadge(status: string) {
  const map: Record<string, { label: string; className: string }> = {
    scanning: { label: 'Scanning', className: 'bg-blue-100 text-blue-700' },
    scanned: { label: 'Ready', className: 'bg-emerald-100 text-emerald-700' },
    running: { label: 'Running', className: 'bg-blue-100 text-blue-700' },
    paused: { label: 'Paused', className: 'bg-yellow-100 text-yellow-700' },
    completed: { label: 'Completed', className: 'bg-emerald-100 text-emerald-700' },
    failed: { label: 'Failed', className: 'bg-red-100 text-red-700' },
    cancelled: { label: 'Cancelled', className: 'bg-slate-100 text-slate-600' },
  }
  const entry = map[status] ?? { label: status, className: 'bg-slate-100 text-slate-600' }
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${entry.className}`}>{entry.label}</span>
}

function mimeToKind(mime: string): 'doc' | 'image' | 'video' | 'pdf' {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf') return 'pdf'
  return 'doc'
}

function browseItemToFile(item: BrowseItem): FileItem {
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    size: formatBytes(item.sizeBytes),
    date: item.modifiedTime ? formatDate(item.modifiedTime) : item.createdAt ? formatDate(item.createdAt) : '',
    access: 'Pending migration',
    kind: mimeToKind(item.mimeType),
    shared: 0,
  }
}

function browseItemToFolder(item: BrowseItem): FolderItem {
  return {
    id: item.sourceFileId,
    name: item.name,
    updated: item.modifiedTime ? formatDate(item.modifiedTime) : item.createdAt ? formatDate(item.createdAt) : '',
    color: 'text-violet-500',
  }
}

export function MigrationPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [sources, setSources] = useState<MigrationSource[]>([])
  const [migrations, setMigrations] = useState<Migration[]>([])
  const [activeMigration, setActiveMigration] = useState<Migration | null>(null)
  const [sourceAccountId, setSourceAccountId] = useState('')
  const [connectingSource, setConnectingSource] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  const [sourceModalOpen, setSourceModalOpen] = useState(false)

  const [scanProgress, setScanProgress] = useState<{ files: number; folders: number; pages: number; bytes: number; currentFolder: string } | null>(null)
  const [scanPhase, setScanPhase] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scannedMigrationId, setScannedMigrationId] = useState<string | null>(null)
  const [scanStopped, setScanStopped] = useState(false)
  const [lastProgressTime, setLastProgressTime] = useState<number>(Date.now())
  const [scanStalled, setScanStalled] = useState(false)

  const [browseItems, setBrowseItems] = useState<BrowseItem[]>([])
  const [browsePage, setBrowsePage] = useState(1)
  const [browseTotalPages, setBrowseTotalPages] = useState(1)
  const [browseParentId, setBrowseParentId] = useState<string | null>(null)
  const [browseBreadcrumbs, setBrowseBreadcrumbs] = useState<{ id: string; name: string }[]>([])
  const [browseType, setBrowseType] = useState('all')
  const [browseExt, setBrowseExt] = useState('')
  const [browseSearch, setBrowseSearch] = useState('')
  const [browseSearchInput, setBrowseSearchInput] = useState('')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [selectedCount, setSelectedCount] = useState(0)
  const [selectedBytes, setSelectedBytes] = useState('0')
  const [browseLoading, setBrowseLoading] = useState(false)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list')
  const [existingScan, setExistingScan] = useState<ScanStatus | null>(null)
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set())
  const [deletingHistory, setDeletingHistory] = useState(false)

  const esRef = useRef<EventSource | null>(null)
  const scannedMigrationIdRef = useRef<string | null>(null)
  const { status: networkStatus, loading: networkLoading, isBlocked: networkBlocked } = useNetworkGuard()
  const isBlocked = networkBlocked ?? false

  const loadSources = useCallback(async () => {
    try { const data = await getMigrationSources(); setSources(data.sources) } catch { /* ignore */ }
  }, [])

  const loadMigrations = useCallback(async () => {
    try { const data = await getMigrations(); setMigrations(data.migrations) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Failed to load migrations') }
  }, [])

  useEffect(() => {
    Promise.all([loadSources(), loadMigrations()]).finally(() => setLoading(false))
  }, [loadSources, loadMigrations])

  useEffect(() => {
    const sp = searchParams.get('source')
    if (sp === 'connected') { setMessage('Google Drive source connected.'); loadSources(); setSearchParams({}, { replace: true }); setSourceModalOpen(true) }
    else if (sp === 'error') { setMessage(`Error: ${searchParams.get('message') ?? 'Connection failed'}`); setSearchParams({}, { replace: true }) }
  }, [searchParams, setSearchParams, loadSources])

  useEffect(() => {
    if (!sourceAccountId) { setExistingScan(null); return }
    checkScanStatus(sourceAccountId).then((status) => {
      setExistingScan(status)
      if (status.exists && status.migrationId) setScannedMigrationId(status.migrationId)
    }).catch(() => setExistingScan(null))
  }, [sourceAccountId])

  const loadBrowse = useCallback(async (migrationId: string, parentId?: string, page = 1, type = 'all', ext = '', search = '') => {
    setBrowseLoading(true)
    try {
      const params: { parentId?: string; type?: string; ext?: string; page?: number; limit?: number; search?: string } = { parentId: parentId ?? undefined, type, page, limit: 50 }
      if (ext) params.ext = ext
      if (search) params.search = search
      const data = await browseMigrationItems(migrationId, params)
      setBrowseItems(data.items)
      setBrowsePage(data.page)
      setBrowseTotalPages(data.totalPages)
      setSelectedCount(data.selectedCount)
      setSelectedBytes(data.selectedBytes)
    } catch { /* ignore */ }
    finally { setBrowseLoading(false) }
  }, [])

  useEffect(() => {
    if (scannedMigrationId) loadBrowse(scannedMigrationId, browseParentId ?? undefined, browsePage, browseType, browseExt, browseSearch)
  }, [scannedMigrationId, browseParentId, browsePage, browseType, browseExt, browseSearch, loadBrowse])

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      setBrowseSearch(browseSearchInput)
      setBrowsePage(1)
    }, 500)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [browseSearchInput])

  useEffect(() => {
    if (!scanning) { setScanStalled(false); return }
    const interval = setInterval(() => {
      if (Date.now() - lastProgressTime > 60_000) {
        setScanStalled(true)
      }
    }, 10_000)
    return () => clearInterval(interval)
  }, [scanning, lastProgressTime])

  useEffect(() => {
    if (!activeMigration || !['running', 'paused'].includes(activeMigration.status)) return
    const es = streamMigration(activeMigration.id, (event) => {
      if (event.type === 'progress') setActiveMigration((p) => p ? { ...p, ...event.data } as Migration : p)
      else if (event.type === 'complete') { setActiveMigration((p) => p ? { ...p, status: 'completed', ...event.data } as Migration : p); loadMigrations(); window.dispatchEvent(new Event('9drive:storage-changed')) }
      else if (event.type === 'error') { setMessage(event.data.message as string); loadMigrations() }
    })
    esRef.current = es
    return () => { es.close(); esRef.current = null }
  }, [activeMigration?.id, activeMigration?.status, loadMigrations])

  async function connectSource() {
    setConnectingSource(true)
    try { const data = await getMigrationSourceConnectUrl(); const popup = window.open(data.url, 'migration-source-connect', 'width=540,height=720'); if (!popup) window.location.href = data.url }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Failed to connect') }
    finally { setConnectingSource(false) }
  }

  async function removeSource(id: string) {
    try { await deleteMigrationSource(id); if (sourceAccountId === id) setSourceAccountId(''); await loadSources() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Failed to remove') }
  }

  function startScanFor(accountId: string) {
    setSourceModalOpen(false)
    setScanning(true)
    setScanProgress(null)
    setScanPhase('connecting')
    setMessage('')
    setScanStopped(false)
    setLastProgressTime(Date.now())
    setScanStalled(false)

    const es = streamScan(accountId, (event) => {
      if (event.type === 'status') {
        setScanPhase(event.data.phase as string)
        if (event.data.migrationId) { setScannedMigrationId(event.data.migrationId as string); scannedMigrationIdRef.current = event.data.migrationId as string }
        if (event.data.phase === 'already_scanning') { setScanPhase('existing') }
      }
      else if (event.type === 'progress') {
        setScanProgress({ files: event.data.files as number, folders: event.data.folders as number, pages: event.data.pages as number, bytes: event.data.bytes as number, currentFolder: (event.data.currentFolder as string) ?? '' })
        setLastProgressTime(Date.now())
      }
      else if (event.type === 'complete') {
        setScannedMigrationId(event.data.migrationId as string)
        setScanProgress({ files: (event.data.totalFiles as number) ?? 0, folders: (event.data.totalFolders as number) ?? 0, pages: 0, bytes: Number(event.data.totalBytes ?? 0), currentFolder: 'My Drive' })
        const warnings = (event.data.warnings as string[]) ?? []
        const timedOut = event.data.timedOut as boolean
        if (timedOut) {
          setMessage(`Scan timed out. ${warnings.length > 0 ? warnings.join('; ') : 'Partial results saved.'}`)
        } else if (warnings.length > 0) {
          setMessage(`Scan completed with warnings: ${warnings.join('; ')}`)
        }
        setScanning(false)
        es.close()
      } else if (event.type === 'error') { setMessage(event.data.message as string); setScanning(false); es.close() }
    })
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return
      if (scannedMigrationIdRef.current) {
        setScanning(false)
      } else {
        setMessage('Connection lost. Click Rescan to try again.')
        setScanStopped(true)
      }
      es.close()
    }
  }

  function handleScan() {
    if (!sourceAccountId) { setMessage('Select a source account.'); setSourceModalOpen(true); return }
    if (existingScan?.exists && existingScan.migrationId) {
      setScannedMigrationId(existingScan.migrationId)
      setScanProgress({ files: existingScan.totalFiles ?? 0, folders: existingScan.totalFolders ?? 0, pages: 0, bytes: Number(existingScan.totalBytes ?? 0), currentFolder: 'My Drive' })
      setSourceModalOpen(false)
      return
    }
    startScanFor(sourceAccountId)
  }

  function resumeScanFromHistory(migration: Migration) {
    setSourceAccountId(migration.sourceAccountId)
    setExistingScan(null)
    startScanFor(migration.sourceAccountId)
  }

  function openFolder(sourceFileId: string, name: string) {
    setBrowseParentId(sourceFileId); setBrowseBreadcrumbs((prev) => [...prev, { id: sourceFileId, name }]); setBrowsePage(1)
  }

  function navigateToBreadcrumb(index: number) {
    if (index < 0) { setBrowseParentId(null); setBrowseBreadcrumbs([]); setBrowsePage(1); return }
    setBrowseParentId(browseBreadcrumbs[index].id); setBrowseBreadcrumbs((prev) => prev.slice(0, index + 1)); setBrowsePage(1)
  }

  async function toggleItem(item: BrowseItem) {
    if (!scannedMigrationId) return
    if (item.status === 'selected') {
      const r = await deselectMigrationItems(scannedMigrationId, { itemIds: [item.id] })
      setSelectedCount(r.selectedCount); setSelectedBytes(r.selectedBytes)
      setBrowseItems((prev) => prev.map((i) => i.id === item.id ? { ...i, status: 'pending' } : i))
    } else {
      const r = await selectMigrationItems(scannedMigrationId, { itemIds: [item.id] })
      setSelectedCount(r.selectedCount); setSelectedBytes(r.selectedBytes)
      setBrowseItems((prev) => prev.map((i) => i.id === item.id ? { ...i, status: 'selected' } : i))
    }
  }

  async function handleSelectAll() {
    if (!scannedMigrationId) return
    const r = await selectMigrationItems(scannedMigrationId, { selectAll: true }); setSelectedCount(r.selectedCount); setSelectedBytes(r.selectedBytes)
    setBrowseItems((prev) => prev.map((i) => i.isFolder ? i : { ...i, status: 'selected' }))
  }

  async function handleDeselectAll() {
    if (!scannedMigrationId) return
    const r = await deselectMigrationItems(scannedMigrationId, { deselectAll: true }); setSelectedCount(r.selectedCount); setSelectedBytes(r.selectedBytes)
    setBrowseItems((prev) => prev.map((i) => ({ ...i, status: 'pending' })))
  }

  async function handleStartMigration() {
    if (!scannedMigrationId) return
    try {
      const dryRun = await getMigrationDryRun(scannedMigrationId)
      if (!dryRun.hasEnoughSpace) {
        setMessage(`Not enough space on target account. Need ${formatBytes(dryRun.totalBytes)}, but only ${formatBytes(dryRun.availableBytes)} available on ${dryRun.targetAccount.email ?? 'target'}.`)
        return
      }
      await startMigrationSelected(scannedMigrationId)
      const detail = await getMigration(scannedMigrationId)
      setActiveMigration(detail.migration)
      setScannedMigrationId(null)
      setBrowseItems([])
      setScanProgress(null)
      setExistingScan(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to start')
    }
  }

  async function handlePause() { if (activeMigration) { await pauseMigration(activeMigration.id); setActiveMigration((p) => p ? { ...p, status: 'paused' } : p) } }
  async function handleResume() { if (activeMigration) { await resumeMigration(activeMigration.id); setActiveMigration((p) => p ? { ...p, status: 'running' } : p) } }
  async function handleCancel() { if (activeMigration) { await cancelMigration(activeMigration.id); setActiveMigration((p) => p ? { ...p, status: 'cancelled' } : p); await loadMigrations() } }
  async function handleRetry() { if (activeMigration) { await retryFailedMigration(activeMigration.id); const d = await getMigration(activeMigration.id); setActiveMigration(d.migration) } }

  function toggleHistorySelection(migrationId: string) {
    setSelectedHistoryIds((current) => {
      const next = new Set(current)
      if (next.has(migrationId)) next.delete(migrationId)
      else next.add(migrationId)
      return next
    })
  }

  function toggleAllHistorySelection() {
    const filteredMigrations = migrations.filter((m) => m.status !== 'scanning' || (m.status === 'scanning' && m.totalFiles === 0))
    const allIds = filteredMigrations.map((m) => m.id)
    const allSelected = allIds.length > 0 && allIds.every((id) => selectedHistoryIds.has(id))
    setSelectedHistoryIds(allSelected ? new Set() : new Set(allIds))
  }

  async function handleDeleteHistory() {
    const ids = Array.from(selectedHistoryIds)
    if (ids.length === 0) return
    setDeletingHistory(true)
    try {
      await deleteMigrations(ids)
      setMessage(`Deleted ${ids.length} migration${ids.length === 1 ? '' : 's'}.`)
      setSelectedHistoryIds(new Set())
      await loadMigrations()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to delete')
    } finally {
      setDeletingHistory(false)
    }
  }

  const isMigrating = activeMigration && ['running', 'paused'].includes(activeMigration.status)
  const isComplete = activeMigration?.status === 'completed'
  const is100 = isComplete && activeMigration.percentComplete === 100

  const browseFolders = browseItems.filter((i) => i.isFolder)
  const browseFiles = browseItems.filter((i) => !i.isFolder)
  const fileItems = browseFiles.map(browseItemToFile)
  const folderItems = browseFolders.map(browseItemToFolder)
  const selectedFileIds = new Set(browseFiles.filter((i) => i.status === 'selected').map((i) => i.id))

  const selectedSource = sources.find((s) => s.id === sourceAccountId)
  const hasBrowse = !!scannedMigrationId && browseItems.length >= 0

  const historyMigrations = migrations.filter((m) => m.status !== 'scanning' || (m.status === 'scanning' && m.totalFiles === 0))

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-blue-600" /></div>

  return (
    <div className="min-h-[620px] w-full min-w-0">
      <PageHeader
        title={scannedMigrationId && browseBreadcrumbs.length > 0 ? (
          <span className="block min-w-0 truncate">
            <button className="text-blue-600 hover:underline" onClick={() => navigateToBreadcrumb(-1)}>Migration</button>
            {browseBreadcrumbs.map((crumb, i) => (
              <span key={crumb.id}>
                <span className="text-slate-400"> / </span>
                {i === browseBreadcrumbs.length - 1
                  ? <span>{crumb.name}</span>
                  : <button className="text-blue-600 hover:underline" onClick={() => navigateToBreadcrumb(i)}>{crumb.name}</button>}
              </span>
            ))}
          </span>
        ) : 'Migration'}
        description="Migrate files from another Google Drive into 9Drive storage."
        actions={
          <>
            <Button variant="outline" onClick={() => setSourceModalOpen(true)}>
              <Users className="h-4 w-4" />
              {selectedSource ? 'Change Source' : 'Setup Source'}
            </Button>
            {sourceAccountId && !scanning && (
              <Button onClick={handleScan} disabled={isBlocked}>
                <Scan className="h-4 w-4" />
                {existingScan?.exists ? 'Browse Scan' : 'Scan Source'}
              </Button>
            )}
          </>
        }
      />

      {message && <p className="mt-5 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">{message}</p>}
      <NetworkWarning status={networkStatus} loading={networkLoading} />

      {selectedSource && (
        <Card className="mt-5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Source Account</p>
              <p className="mt-1 truncate font-extrabold">{selectedSource.displayName || selectedSource.email}</p>
              <p className="truncate text-xs text-slate-500">{selectedSource.email}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setSourceModalOpen(true)}>Change</Button>
          </div>
        </Card>
      )}

      {scanning && (
        <Card className="mt-5 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-2">
              {!scanStopped && <Loader2 className="h-5 w-5 animate-spin text-blue-600" />}
              <div>
                <p className="text-sm font-extrabold text-slate-900">{scanStopped ? 'Scan Paused' : scanPhase === 'connecting' ? 'Connecting to Google Drive...' : scanPhase === 'scanning' ? 'Scanning source files...' : 'Starting scan...'}</p>
                {scanProgress?.currentFolder && <p className="mt-0.5 text-xs text-slate-500">Last scanned: <span className="font-semibold text-slate-700">{scanProgress.currentFolder}</span></p>}
              </div>
            </div>
            <div className="flex gap-2">
              {scanStopped && sourceAccountId && <Button size="sm" onClick={() => { setScanStopped(false); startScanFor(sourceAccountId) }}><RotateCcw className="h-4 w-4" />Resume</Button>}
              {scanStopped && <Button variant="outline" size="sm" onClick={() => { setScanStopped(false); setScanning(false); setMessage('') }}>Dismiss</Button>}
            </div>
          </div>
          {scanStalled && !scanStopped && (
            <div className="mt-3 rounded-xl bg-amber-50 p-3">
              <p className="text-sm font-bold text-amber-700">Scanning appears to be stalled</p>
              <p className="mt-1 text-xs text-amber-600">No progress for 60 seconds. The scan may be stuck on a large folder.</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => { setScanStalled(false); setLastProgressTime(Date.now()) }}>Continue Waiting</Button>
                <Button variant="outline" size="sm" onClick={() => { setScanStopped(true); setMessage('Scan paused by user.') }}>Pause</Button>
              </div>
            </div>
          )}
          {scanProgress && (
            <div className="mt-4 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
              <div className="rounded-xl bg-emerald-50 p-3"><p className="text-lg font-extrabold text-emerald-700">{formatBytes(scanProgress.bytes)}</p><p className="text-xs text-emerald-600">Scanned</p></div>
              <div className="rounded-xl bg-blue-50 p-3"><p className="text-lg font-extrabold text-blue-700">{scanProgress.files.toLocaleString()}</p><p className="text-xs text-blue-600">Files</p></div>
              <div className="rounded-xl bg-violet-50 p-3"><p className="text-lg font-extrabold text-violet-700">{scanProgress.folders.toLocaleString()}</p><p className="text-xs text-violet-600">Folders</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-lg font-extrabold text-slate-700">{scanProgress.pages}</p><p className="text-xs text-slate-500">Pages</p></div>
            </div>
          )}
        </Card>
      )}

      {activeMigration && (
        <Card className="mt-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-extrabold text-slate-900">Migration Progress</p>
                {statusBadge(activeMigration.status)}
                {is100 && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-700"><CheckCircle className="h-3 w-3" />100%</span>}
              </div>
              <p className="mt-1 truncate text-xs text-slate-500">From: {activeMigration.sourceAccount?.email ?? 'Unknown'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {isMigrating && activeMigration.status === 'running' && <Button variant="outline" size="sm" onClick={handlePause}><Pause className="h-4 w-4" />Pause</Button>}
              {isMigrating && activeMigration.status === 'paused' && <Button variant="outline" size="sm" onClick={handleResume}><Play className="h-4 w-4" />Resume</Button>}
              {isMigrating && <Button variant="danger" size="sm" onClick={handleCancel}><XCircle className="h-4 w-4" />Cancel</Button>}
              {activeMigration.status === 'completed' && activeMigration.failedFiles > 0 && <Button variant="outline" size="sm" onClick={handleRetry}><RotateCcw className="h-4 w-4" />Retry Failed</Button>}
              {!isMigrating && <Button variant="outline" size="sm" onClick={() => { setActiveMigration(null); loadMigrations() }}>Dismiss</Button>}
            </div>
          </div>
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className={cn('font-bold', is100 ? 'text-emerald-600' : '')}>{is100 ? 'Migration Complete' : `${activeMigration.percentComplete}% complete`}</span>
              <span className="text-slate-500">{formatBytes(activeMigration.migratedBytes)} / {formatBytes(activeMigration.totalBytes)}</span>
            </div>
            <div className="h-2.5 rounded-full bg-slate-100"><div className={cn('h-full rounded-full transition-all duration-500', is100 ? 'bg-emerald-500' : 'bg-blue-600')} style={{ width: `${activeMigration.percentComplete}%` }} /></div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl bg-emerald-50 p-3 text-center"><p className="text-xs text-emerald-600">Completed</p><p className="text-lg font-extrabold text-emerald-700">{activeMigration.completedFiles}</p></div>
            <div className="rounded-xl bg-red-50 p-3 text-center"><p className="text-xs text-red-600">Failed</p><p className="text-lg font-extrabold text-red-700">{activeMigration.failedFiles}</p></div>
            <div className="rounded-xl bg-slate-50 p-3 text-center"><p className="text-xs text-slate-500">Skipped</p><p className="text-lg font-extrabold">{activeMigration.skippedFiles}</p></div>
            <div className="rounded-xl bg-slate-50 p-3 text-center"><p className="text-xs text-slate-500">Total</p><p className="text-lg font-extrabold">{activeMigration.totalFiles}</p></div>
          </div>
        </Card>
      )}

      {hasBrowse && scanProgress && !scanning && (
        <Card className="mt-5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-emerald-600" />
              <p className="text-sm font-bold text-emerald-700">{scanProgress.pages > 0 ? 'Scan Complete' : 'Scan Ready'}</p>
            </div>
            <div className="grid grid-cols-4 gap-3 text-center sm:flex sm:gap-6">
              <div><p className="text-sm font-extrabold text-emerald-700">{formatBytes(scanProgress.bytes)}</p><p className="text-[10px] uppercase text-emerald-500">Size</p></div>
              <div><p className="text-sm font-extrabold text-blue-700">{scanProgress.files.toLocaleString()}</p><p className="text-[10px] uppercase text-blue-500">Files</p></div>
              <div><p className="text-sm font-extrabold text-violet-700">{scanProgress.folders.toLocaleString()}</p><p className="text-[10px] uppercase text-violet-500">Folders</p></div>
              <div><p className="text-sm font-extrabold text-slate-700">{selectedCount}</p><p className="text-[10px] uppercase text-slate-500">Selected</p></div>
            </div>
            <Button variant="outline" size="sm" onClick={handleScan}><Scan className="h-4 w-4" />Rescan</Button>
          </div>
        </Card>
      )}

      {hasBrowse && (
        <>
          {browseLoading && <div className="mt-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-blue-600" /></div>}
          {!browseLoading && browseParentId === null && folderItems.length > 0 && (
            <div className="mt-6">
              <FolderGrid items={folderItems} mobileTwoColumns onFolderOpen={(folder) => { const bi = browseFolders.find((f) => f.sourceFileId === folder.id); if (bi) openFolder(bi.sourceFileId, bi.name) }} />
            </div>
          )}
          {!browseLoading && browseParentId !== null && browseFolders.length > 0 && (
            <Card className="mt-5 p-4 sm:p-5">
              <h2 className="font-extrabold">Folders</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {browseFolders.map((folder) => (
                  <div key={folder.id} onClick={() => openFolder(folder.sourceFileId, folder.name)} className="flex cursor-pointer items-center justify-between gap-3 rounded-xl bg-slate-50 p-3 hover:bg-slate-100">
                    <div className="flex min-w-0 items-center gap-3">
                      <FolderVisual folder={{ color: 'text-violet-500' }} className="h-6 w-6 shrink-0" />
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{folder.name}</p>
                        <p className="truncate text-xs text-slate-500">Folder</p>
                      </div>
                    </div>
                    <ChevronRight className="h-5 w-5 shrink-0 text-slate-400" />
                  </div>
                ))}
              </div>
            </Card>
          )}

          <div className="mt-8 flex flex-col gap-3 sm:mt-10 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input type="text" value={browseSearchInput} onChange={(e) => setBrowseSearchInput(e.target.value)} placeholder="Search files..." className="h-9 rounded-xl border border-slate-200 bg-white pl-9 pr-8 text-sm outline-none focus:border-blue-400" />
                {browseSearchInput && <button onClick={() => { setBrowseSearchInput(''); setBrowseSearch(''); setBrowsePage(1) }} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>}
              </div>
              <select className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm" value={browseType} onChange={(e) => { setBrowseType(e.target.value); setBrowsePage(1) }}>
                <option value="all">Type: All</option>
                <option value="files">Type: Files</option>
                <option value="folders">Type: Folders</option>
              </select>
              <select className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm" value={browseExt} onChange={(e) => { setBrowseExt(e.target.value); setBrowsePage(1) }}>
                <option value="">Ext: All</option>
                <option value="jpg">.jpg</option><option value="jpeg">.jpeg</option><option value="png">.png</option><option value="gif">.gif</option><option value="webp">.webp</option>
                <option value="mp4">.mp4</option><option value="mkv">.mkv</option><option value="avi">.avi</option><option value="mov">.mov</option>
                <option value="mp3">.mp3</option><option value="wav">.wav</option>
                <option value="pdf">.pdf</option><option value="doc">.doc</option><option value="docx">.docx</option><option value="xls">.xls</option><option value="xlsx">.xlsx</option>
                <option value="zip">.zip</option><option value="rar">.rar</option><option value="tar">.tar</option><option value="gz">.gz</option><option value="7z">.7z</option>
                <option value="js">.js</option><option value="ts">.ts</option><option value="py">.py</option><option value="json">.json</option><option value="html">.html</option><option value="css">.css</option>
              </select>
              {selectedCount > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-extrabold text-slate-700">{selectedCount} selected · {formatBytes(selectedBytes)}</span>
                  <Button size="sm" onClick={handleStartMigration} disabled={isBlocked}><ArrowRightLeft className="h-4 w-4" />Migrate</Button>
                  <Button variant="ghost" size="sm" onClick={handleDeselectAll}>Clear</Button>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleSelectAll}>Select All</Button>
              <Button variant={viewMode === 'grid' ? 'soft' : 'outline'} size="icon" aria-label="Grid view" onClick={() => setViewMode('grid')}><Grid3X3 className="h-5 w-5" /></Button>
              <Button variant={viewMode === 'list' ? 'soft' : 'outline'} size="icon" aria-label="List view" onClick={() => setViewMode('list')}><LayoutList className="h-5 w-5" /></Button>
            </div>
          </div>

          {!browseLoading && fileItems.length === 0 && browseFolders.length === 0 && (
            <p className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-500">No files in this folder.</p>
          )}
          <div className="mt-4">
            {!browseLoading && fileItems.length > 0 && (viewMode === 'grid'
              ? <FileGrid files={fileItems} selectedFileIds={selectedFileIds} onToggleFile={(file) => { const bi = browseFiles.find((f) => f.id === file.id); if (bi) toggleItem(bi) }} />
              : <FileTable files={fileItems} selectedFileIds={selectedFileIds} allSelected={fileItems.length > 0 && fileItems.every((f) => selectedFileIds.has(f.id ?? ''))} onToggleFile={(file) => { const bi = browseFiles.find((f) => f.id === file.id); if (bi) toggleItem(bi) }} onToggleAll={() => { const allVisibleSelected = fileItems.every((f) => selectedFileIds.has(f.id ?? '')); allVisibleSelected ? handleDeselectAll() : handleSelectAll() }} />)}
            {browseTotalPages > 1 && (
              <div className="mt-3 flex items-center justify-between text-sm">
                <Button variant="outline" size="sm" disabled={browsePage <= 1} onClick={() => setBrowsePage(browsePage - 1)}>Previous</Button>
                <span className="text-slate-500">Page {browsePage} of {browseTotalPages}</span>
                <Button variant="outline" size="sm" disabled={browsePage >= browseTotalPages} onClick={() => setBrowsePage(browsePage + 1)}>Next</Button>
              </div>
            )}
          </div>
        </>
      )}

      {!hasBrowse && !scanning && !activeMigration && (
        <Card className="mt-6 p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
            <ArrowRightLeft className="h-6 w-6 text-blue-600" />
          </div>
          <h2 className="mt-4 text-lg font-extrabold">No migration in progress</h2>
          <p className="mt-1 text-sm text-slate-500">Setup a source Google Drive account to start migrating files.</p>
          <Button className="mt-4" onClick={() => setSourceModalOpen(true)}>
            <Users className="h-4 w-4" />
            {sources.length > 0 ? 'Choose Source' : 'Setup Source'}
          </Button>
        </Card>
      )}

      {historyMigrations.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-extrabold">Migration History</h2>
            <div className="flex items-center gap-2">
              {selectedHistoryIds.size > 0 && (
                <Button variant="danger" size="sm" onClick={handleDeleteHistory} disabled={deletingHistory}>
                  <Trash2 className="h-4 w-4" />{deletingHistory ? 'Deleting...' : `Delete (${selectedHistoryIds.size})`}
                </Button>
              )}
              <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-600">
                <input
                  type="checkbox"
                  checked={historyMigrations.length > 0 && historyMigrations.every((m) => selectedHistoryIds.has(m.id))}
                  onChange={toggleAllHistorySelection}
                  className="h-4 w-4 rounded border-slate-300 accent-blue-600"
                />
                Select All
              </label>
            </div>
          </div>
          <div className="mt-3 grid gap-3">
            {historyMigrations.map((m) => {
              const isDone = m.status === 'completed' && m.percentComplete === 100
              const isStuckScanning = m.status === 'scanning' && m.totalFiles === 0
              const canResume = (m.status === 'failed' || m.status === 'cancelled' || isStuckScanning)
              return (
                <div key={m.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-blue-300 hover:shadow-sm">
                  <input
                    type="checkbox"
                    checked={selectedHistoryIds.has(m.id)}
                    onChange={() => toggleHistorySelection(m.id)}
                    className="h-5 w-5 shrink-0 rounded border-slate-300 accent-blue-600"
                    aria-label={`Select migration from ${m.sourceAccount?.email ?? 'Unknown'}`}
                  />
                  <button type="button" onClick={() => {
                    if (m.status === 'scanned') {
                      setSourceAccountId(m.sourceAccountId)
                      setScannedMigrationId(m.id)
                      setScanProgress({ files: m.totalFiles ?? 0, folders: m.totalFolders ?? 0, pages: 0, bytes: Number(m.totalBytes ?? 0), currentFolder: 'My Drive' })
                    } else {
                      setActiveMigration(m)
                    }
                  }} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">{statusBadge(m.status)}{isDone && <CheckCircle className="h-4 w-4 text-emerald-500" />}</div>
                      <p className="mt-1 text-sm font-semibold">From: {m.sourceAccount?.email ?? 'Unknown'}</p>
                      <p className="text-xs text-slate-500">{m.totalFiles > 0 ? `${m.completedFiles}/${m.totalFiles} files` : isStuckScanning ? 'Scan interrupted' : 'Scanning...'} · {formatDate(m.createdAt)}</p>
                      {m.totalFiles > 0 && <div className="mt-2 h-2 w-full max-w-[200px] rounded-full bg-slate-100"><div className={cn('h-full rounded-full transition-all', isDone ? 'bg-emerald-500' : 'bg-blue-500')} style={{ width: `${m.percentComplete}%` }} /></div>}
                    </div>
                    <span className={cn('text-sm font-bold', isDone ? 'text-emerald-600' : m.totalFiles > 0 ? '' : 'text-slate-400')}>{m.totalFiles > 0 ? `${m.percentComplete}%` : '—'}</span>
                  </button>
                  {canResume && (
                    <Button variant="outline" size="sm" className="shrink-0" onClick={(e) => { e.stopPropagation(); resumeScanFromHistory(m) }}>
                      <RotateCcw className="mr-1 h-3.5 w-3.5" />Resume
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <DummyModal
        open={sourceModalOpen}
        title="Migration Source"
        description="Select or connect a Google Drive account to migrate files from."
        onClose={() => setSourceModalOpen(false)}
        className="sm:max-w-lg"
      >
        <div className="grid gap-4">
          {sources.length > 0 ? (
            <div className="grid gap-2">
              {sources.map((src) => (
                <label key={src.id} className={cn('flex cursor-pointer items-center gap-3 rounded-xl border-2 p-3 transition', sourceAccountId === src.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300')}>
                  <input type="radio" name="source" value={src.id} checked={sourceAccountId === src.id} onChange={() => setSourceAccountId(src.id)} className="h-4 w-4 accent-blue-600" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{src.displayName || src.email}</p>
                    <p className="truncate text-xs text-slate-500">{src.email}</p>
                  </div>
                  <button type="button" onClick={(e) => { e.preventDefault(); removeSource(src.id) }} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500" aria-label={`Remove ${src.email}`}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </label>
              ))}
            </div>
          ) : (
            <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No source accounts connected yet. Connect a Google Drive account to start migrating.</p>
          )}

          <Button variant="outline" onClick={connectSource} disabled={connectingSource} className="w-full">
            {connectingSource ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            {connectingSource ? 'Connecting...' : 'Connect New Source'}
          </Button>

          {sourceAccountId && existingScan?.exists && (
            <div className="rounded-xl bg-emerald-50 p-4">
              <p className="text-sm font-bold text-emerald-700">Previous scan found</p>
              <p className="mt-1 text-xs text-emerald-600">{existingScan.totalFiles?.toLocaleString()} files, {existingScan.totalFolders?.toLocaleString()} folders ({formatBytes(existingScan.totalBytes)})</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Button onClick={handleScan}>Browse & Select ({existingScan.itemCount?.toLocaleString()})</Button>
                <Button variant="outline" onClick={() => { setExistingScan(null); startScanFor(sourceAccountId) }}><Scan className="h-4 w-4" />Rescan</Button>
              </div>
            </div>
          )}

          {sourceAccountId && !existingScan?.exists && (
            <Button onClick={handleScan} disabled={!sourceAccountId || isBlocked} className="w-full">
              <Scan className="h-4 w-4" />Scan & Preview
            </Button>
          )}
        </div>
      </DummyModal>
    </div>
  )
}
