import { useEffect, useState } from 'react'
import { AlertTriangle, Wifi, Globe, Cable, Smartphone, ShieldBan, Network, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isTransferAllowed, getBlockMessage, getNetworkSettings } from '@/lib/network-settings'

export type NetworkStatus = {
  interface: string
  connectionType: 'wifi' | 'ethernet' | 'cellular' | 'tethered' | 'tunnel' | 'unknown'
  isMetered: boolean
  warning: string | null
  details: string
  publicIp: string | null
  isp: string | null
  carrierDetected: boolean
}

function connectionIcon(type: NetworkStatus['connectionType']) {
  switch (type) {
    case 'wifi': return <Wifi className="h-5 w-5 text-emerald-600" />
    case 'ethernet': return <Cable className="h-5 w-5 text-emerald-600" />
    case 'cellular': return <Smartphone className="h-5 w-5 text-red-600" />
    case 'tethered': return <Smartphone className="h-5 w-5 text-amber-600" />
    case 'tunnel': return <Network className="h-5 w-5 text-violet-600" />
    default: return <Globe className="h-5 w-5 text-slate-500" />
  }
}

function connectionLabel(type: NetworkStatus['connectionType']) {
  switch (type) {
    case 'wifi': return 'WiFi'
    case 'ethernet': return 'Ethernet'
    case 'cellular': return 'Seluler (SIM)'
    case 'tethered': return 'Tethering'
    case 'tunnel': return 'VPN/Tunnel'
    default: return 'Tidak diketahui'
  }
}

export function useNetworkStatus() {
  const [status, setStatus] = useState<NetworkStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch<NetworkStatus>('/settings/network-status')
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false))
  }, [])

  return { status, loading }
}

export function useNetworkGuard() {
  const { status, loading } = useNetworkStatus()
  const [settings, setSettings] = useState(getNetworkSettings)

  useEffect(() => {
    const handler = () => setSettings(getNetworkSettings())
    window.addEventListener('9drive:network-settings-changed', handler)
    return () => window.removeEventListener('9drive:network-settings-changed', handler)
  }, [])

  const isAllowed = !status || isTransferAllowed(status.connectionType, settings)
  const isBlocked = !loading && status?.isMetered && !isAllowed

  return { status, loading, settings, isAllowed, isBlocked }
}

export function NetworkWarning({ status, loading }: { status: NetworkStatus | null; loading: boolean }) {
  const [settings, setSettings] = useState(getNetworkSettings)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const handler = () => setSettings(getNetworkSettings())
    window.addEventListener('9drive:network-settings-changed', handler)
    return () => window.removeEventListener('9drive:network-settings-changed', handler)
  }, [])

  useEffect(() => {
    setDismissed(false)
  }, [status?.connectionType, status?.publicIp])

  if (loading || !status || dismissed) return null
  if (!status.isMetered && status.connectionType !== 'tunnel') return null

  const allowed = isTransferAllowed(status.connectionType, settings)

  if (status.connectionType === 'tunnel') {
    return (
      <div className="mt-4 rounded-xl border-2 border-violet-200 bg-violet-50 p-4">
        <div className="flex items-start gap-3">
          <Network className="mt-0.5 h-5 w-5 shrink-0 text-violet-600" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-violet-700">VPN/Tunnel Terdeteksi</p>
            <p className="mt-1 text-sm text-violet-600">{status.warning}</p>
            {status.publicIp && <p className="mt-1 text-xs text-violet-500">IP Publik: {status.publicIp} — {status.isp ?? 'Unknown'}</p>}
          </div>
          <button type="button" onClick={() => setDismissed(true)} className="shrink-0 rounded-lg p-1 text-violet-400 transition hover:bg-violet-100 hover:text-violet-600" aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  if (allowed) {
    return (
      <div className="mt-4 rounded-xl border-2 border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-amber-700">Info: Koneksi {connectionLabel(status.connectionType)}</p>
            <p className="mt-1 text-sm text-amber-600">{status.warning}</p>
            {status.publicIp && <p className="mt-1 text-xs text-amber-500">IP Publik: {status.publicIp} — {status.isp ?? 'Unknown'}</p>}
            <p className="mt-1 text-xs text-amber-500">Anda mengizinkan transfer via koneksi ini di Settings.</p>
          </div>
          <button type="button" onClick={() => setDismissed(true)} className="shrink-0 rounded-lg p-1 text-amber-400 transition hover:bg-amber-100 hover:text-amber-600" aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-xl border-2 border-red-200 bg-red-50 p-4">
      <div className="flex items-start gap-3">
        <ShieldBan className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-red-700">Transfer Diblokir</p>
          <p className="mt-1 text-sm text-red-600">{getBlockMessage(status.connectionType)}</p>
          {status.publicIp && <p className="mt-1 text-xs text-red-500">IP Publik: {status.publicIp} — {status.isp ?? 'Unknown'}</p>}
          <p className="mt-1 text-xs text-red-500">Buka Settings → Network untuk mengubah preferensi koneksi.</p>
        </div>
        <button type="button" onClick={() => setDismissed(true)} className="shrink-0 rounded-lg p-1 text-red-400 transition hover:bg-red-100 hover:text-red-600" aria-label="Dismiss">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export function NetworkStatusBadge({ status, loading }: { status: NetworkStatus | null; loading: boolean }) {
  if (loading || !status) return null

  const colorClass = status.isMetered
    ? 'border-red-200 bg-red-50 text-red-700'
    : status.connectionType === 'tunnel'
      ? 'border-violet-200 bg-violet-50 text-violet-700'
      : 'border-emerald-200 bg-emerald-50 text-emerald-700'

  return (
    <div className={cn('inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold', colorClass)}>
      {connectionIcon(status.connectionType)}
      <span>{connectionLabel(status.connectionType)}</span>
      {status.carrierDetected && <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-800">OPERATOR</span>}
      {status.isMetered && !status.carrierDetected && <span className="rounded-full bg-red-200 px-2 py-0.5 text-[10px] font-bold text-red-800">KUOTA</span>}
    </div>
  )
}
