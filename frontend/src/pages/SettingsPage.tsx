import { useEffect, useState, type FormEvent } from 'react'
import { Bell, Cloud, Database, Globe, HardDrive, Link2, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DummyModal } from '@/components/drive/DummyModal'
import { PageHeader } from '@/components/drive/PageHeader'
import { NetworkWarning, NetworkStatusBadge, useNetworkStatus } from '@/components/drive/NetworkWarning'
import { apiFetch, formatBytes } from '@/lib/api'
import { cn } from '@/lib/utils'
import { getGravatarUrl } from '@/lib/gravatar'
import { getStoredUser } from '@/lib/auth'
import { getNetworkSettings, setNetworkSettings, type NetworkSettings } from '@/lib/network-settings'

type ConnectedAccount = { id: string; provider: string; email: string; displayName?: string | null; status: string; storageAccount?: { totalBytes: string | null; usedBytes: string; availableBytes: string | null; lastSyncedAt: string | null } | null }

function providerLabel(provider: string) {
  if (provider === 's3') return 'S3 Storage'
  return 'Google Drive'
}

function storageLimitLabel(account: ConnectedAccount) {
  if (account.provider === 's3' && account.storageAccount?.totalBytes === null) return 'Unlimited'
  return formatBytes(account.storageAccount?.totalBytes)
}

function availableLabel(account: ConnectedAccount) {
  if (account.provider === 's3' && account.storageAccount?.availableBytes === null) return 'Unlimited'
  return formatBytes(account.storageAccount?.availableBytes)
}

export function SettingsPage() {
  const user = getStoredUser()
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [message, setMessage] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [s3Open, setS3Open] = useState(false)
  const [connectingS3, setConnectingS3] = useState(false)
  const [s3Form, setS3Form] = useState({ name: '', bucket: '', region: 'us-east-1', endpoint: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: false, quotaBytes: '' })
  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null)
  const [disconnectingAccountId, setDisconnectingAccountId] = useState<string | null>(null)
  const [accountToDisconnect, setAccountToDisconnect] = useState<ConnectedAccount | null>(null)
  const [profileImageUrl, setProfileImageUrl] = useState('')
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? accounts[0] ?? null
  const { status: networkStatus, loading: networkLoading } = useNetworkStatus()
  const [netSettings, setNetSettings] = useState(getNetworkSettings)

  function updateNetSettings(next: NetworkSettings) {
    setNetSettings(next)
    setNetworkSettings(next)
    window.dispatchEvent(new Event('9drive:network-settings-changed'))
  }

  async function load() {
    const data = await apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts')
    setAccounts(data.accounts)
  }

  useEffect(() => {
    load().catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to load settings'))
  }, [])

  useEffect(() => {
    getGravatarUrl(user?.email, 96).then(setProfileImageUrl).catch(() => setProfileImageUrl(''))
  }, [user?.email])

  useEffect(() => {
    if (accounts.length === 0) {
      setSelectedAccountId('')
      return
    }
    if (!accounts.some((account) => account.id === selectedAccountId)) setSelectedAccountId(accounts[0].id)
  }, [accounts, selectedAccountId])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.data?.type !== 'GOOGLE_CONNECTED') return
      setMessage(event.data.status === 'success' ? 'Google Drive connected.' : 'Google Drive connection failed.')
      load().catch(() => undefined)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  async function connectDrive() {
    setConnecting(true)
    setMessage('')
    try {
      const data = await apiFetch<{ url: string }>('/connected-accounts/google/connect-url')
      const popup = window.open(data.url, 'google-drive-connect', 'width=540,height=720')
      if (!popup) window.location.href = data.url
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to start Google Drive connection')
    } finally {
      setConnecting(false)
    }
  }

  async function sync(accountId: string) {
    setSyncingAccountId(accountId)
    try {
      await apiFetch(`/connected-accounts/${accountId}/sync-quota`, { method: 'POST' })
      await load()
    } finally {
      setSyncingAccountId(null)
    }
  }

  async function disconnect() {
    if (!accountToDisconnect) return
    setDisconnectingAccountId(accountToDisconnect.id)
    setMessage('')
    try {
      await apiFetch(`/connected-accounts/${accountToDisconnect.id}`, { method: 'DELETE' })
      setAccountToDisconnect(null)
      setMessage('Storage account disconnected.')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to disconnect Google Drive account')
    } finally {
      setDisconnectingAccountId(null)
    }
  }

  async function connectS3(event: FormEvent) {
    event.preventDefault()
    setConnectingS3(true)
    setMessage('')
    try {
      await apiFetch('/connected-accounts/s3', { method: 'POST', body: JSON.stringify({ ...s3Form, endpoint: s3Form.endpoint || undefined, quotaBytes: s3Form.quotaBytes || null }) })
      setS3Open(false)
      setS3Form({ name: '', bucket: '', region: 'us-east-1', endpoint: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: false, quotaBytes: '' })
      setMessage('S3 storage connected.')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to connect S3 storage')
    } finally {
      setConnectingS3(false)
    }
  }

  return (
    <>
      <PageHeader title="Setting" description="Manage account and connected storage." actions={<><Button variant="outline" className="col-span-2 w-full sm:col-span-1" onClick={() => setS3Open(true)}><Database className="h-4 w-4" />Connect S3</Button><Button className="col-span-2 w-full sm:col-span-1" onClick={connectDrive} disabled={connecting}><Link2 className="h-4 w-4" />{connecting ? 'Connecting...' : 'Connect Drive'}</Button></>} />
      {message ? <p className="mt-5 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">{message}</p> : null}
      <NetworkWarning status={networkStatus} loading={networkLoading} />
      <div className="mt-8 grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="grid gap-6">
          <Card className="p-4 sm:p-5">
            <div className="flex items-center gap-4 sm:gap-5">
              <img src={profileImageUrl} alt="User avatar" className="h-16 w-16 rounded-2xl object-cover sm:h-20 sm:w-20" />
              <div className="flex-1"><h2 className="text-xl font-extrabold">{user?.name ?? 'User'}</h2><p className="text-sm text-slate-500">{user?.email ?? '-'}</p></div>
            </div>
          </Card>

          <Card className="overflow-hidden p-4 sm:p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-3"><Cloud className="h-6 w-6 text-blue-600" /><h2 className="text-xl font-extrabold">Google Drive</h2></div>
                <p className="mt-2 text-sm text-slate-500">Connect one or more Google Drive accounts. 9Drive will route uploads to account with enough space.</p>
              </div>
              <Button className="w-full sm:w-36" onClick={connectDrive} disabled={connecting}><Link2 className="h-4 w-4" />{connecting ? 'Opening...' : 'Connect Drive'}</Button>
            </div>
          </Card>

          <Card className="overflow-hidden p-4 sm:p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-3"><Database className="h-6 w-6 text-blue-600" /><h2 className="text-xl font-extrabold">S3 Compatible</h2></div>
                <p className="mt-2 text-sm text-slate-500">Connect AWS S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2, or custom endpoint storage.</p>
              </div>
              <Button className="w-full sm:w-36" variant="outline" onClick={() => setS3Open(true)}><Database className="h-4 w-4" />Connect S3</Button>
            </div>
          </Card>

          <Card className="p-4 sm:p-5">
            <h2 className="font-extrabold">Connected Storage Accounts</h2>
            <div className="mt-4 grid gap-3">
              {accounts.length === 0 ? <p className="text-sm text-slate-500">No connected storage account yet.</p> : <>
                <label className="grid gap-2 text-sm font-semibold">Choose Account<select className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm" value={selectedAccount?.id ?? ''} onChange={(event) => setSelectedAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{providerLabel(account.provider)} - {account.displayName || account.email} ({account.status})</option>)}</select></label>
                {selectedAccount ? <div className="rounded-xl bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0"><p className="break-all font-semibold">{selectedAccount.displayName || selectedAccount.email}</p><p className="text-sm text-slate-500">{providerLabel(selectedAccount.provider)} · {selectedAccount.status}</p></div>
                    <div className="grid grid-cols-2 gap-2 sm:flex"><Button className="w-full" variant="outline" onClick={() => sync(selectedAccount.id)} disabled={syncingAccountId === selectedAccount.id}><RefreshCw className={syncingAccountId === selectedAccount.id ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />{syncingAccountId === selectedAccount.id ? 'Syncing...' : 'Sync'}</Button><Button className="w-full" variant="danger" onClick={() => setAccountToDisconnect(selectedAccount)}><Trash2 className="h-4 w-4" />Disconnect</Button></div>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs sm:text-sm">
                    <div className="rounded-xl bg-white p-3"><p className="font-extrabold text-slate-950">{formatBytes(selectedAccount.storageAccount?.usedBytes)}</p><p className="mt-1 text-slate-500">Used</p></div>
                    <div className="rounded-xl bg-white p-3"><p className="font-extrabold text-slate-950">{storageLimitLabel(selectedAccount)}</p><p className="mt-1 text-slate-500">Total</p></div>
                    <div className="rounded-xl bg-white p-3"><p className="font-extrabold text-slate-950">{availableLabel(selectedAccount)}</p><p className="mt-1 text-slate-500">Free</p></div>
                  </div>
                </div> : null}
              </>}
            </div>
          </Card>
        </div>
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1 xl:gap-6">
          <Card className="p-4 sm:p-5"><HardDrive className="h-6 w-6 text-blue-600" /><h2 className="mt-3 font-extrabold sm:mt-4">Storage</h2><p className="mt-1 text-sm text-slate-500">Connected accounts: {accounts.length}</p></Card>
          <Card className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="h-6 w-6 text-blue-600" />
                <h2 className="font-extrabold">Network</h2>
              </div>
              <NetworkStatusBadge status={networkStatus} loading={networkLoading} />
            </div>
            {networkStatus && (
              <div className="mt-3 space-y-1.5 rounded-xl bg-slate-50 p-3 text-xs">
                <div className="flex justify-between"><span className="text-slate-500">Interface</span><span className="font-semibold">{networkStatus.interface}</span></div>
                {networkStatus.publicIp && <div className="flex justify-between"><span className="text-slate-500">IP Publik</span><span className="font-semibold">{networkStatus.publicIp}</span></div>}
                {networkStatus.isp && <div className="flex justify-between"><span className="text-slate-500">ISP</span><span className="font-semibold truncate ml-4 max-w-[60%] text-right">{networkStatus.isp}</span></div>}
                {networkStatus.carrierDetected && <div className="flex justify-between"><span className="text-slate-500">Operator Seluler</span><span className="font-bold text-red-600">Terdeteksi</span></div>}
              </div>
            )}
            <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
              <p className="text-xs font-bold text-slate-600">Izinkan Transfer Via:</p>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-slate-500" />Kuota Seluler (SIM)</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={netSettings.allowCellular}
                  onClick={() => updateNetSettings({ ...netSettings, allowCellular: !netSettings.allowCellular })}
                  className={cn('relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors', netSettings.allowCellular ? 'bg-blue-600' : 'bg-slate-300')}
                >
                  <span className={cn('pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-0 transition-transform', netSettings.allowCellular ? 'translate-x-5' : 'translate-x-0')} />
                </button>
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-slate-500" />Tethering / USB</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={netSettings.allowTethered}
                  onClick={() => updateNetSettings({ ...netSettings, allowTethered: !netSettings.allowTethered })}
                  className={cn('relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors', netSettings.allowTethered ? 'bg-blue-600' : 'bg-slate-300')}
                >
                  <span className={cn('pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-0 transition-transform', netSettings.allowTethered ? 'translate-x-5' : 'translate-x-0')} />
                </button>
              </label>
              {networkStatus?.isMetered && !netSettings.allowCellular && netSettings.allowTethered === false && (
                <p className="text-xs font-semibold text-red-600">Transfer akan diblokir saat pakai kuota seluler.</p>
              )}
            </div>
          </Card>
          <Card className="p-4 sm:p-5"><Bell className="h-6 w-6 text-blue-600" /><h2 className="mt-3 font-extrabold sm:mt-4">Notifications</h2><p className="mt-1 text-sm text-slate-500">Email and app alerts are active.</p></Card>
        </div>
      </div>
      <DummyModal open={s3Open} title="Connect S3 Storage" description="Use any S3-compatible provider with custom endpoint support." onClose={() => setS3Open(false)}>
        <form className="grid gap-4" onSubmit={connectS3}>
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Display name" value={s3Form.name} onChange={(event) => setS3Form({ ...s3Form, name: event.target.value })} required />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Bucket" value={s3Form.bucket} onChange={(event) => setS3Form({ ...s3Form, bucket: event.target.value })} required />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Region" value={s3Form.region} onChange={(event) => setS3Form({ ...s3Form, region: event.target.value })} required />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Endpoint URL (optional)" value={s3Form.endpoint} onChange={(event) => setS3Form({ ...s3Form, endpoint: event.target.value })} />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Access key ID" value={s3Form.accessKeyId} onChange={(event) => setS3Form({ ...s3Form, accessKeyId: event.target.value })} required />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Secret access key" type="password" value={s3Form.secretAccessKey} onChange={(event) => setS3Form({ ...s3Form, secretAccessKey: event.target.value })} required />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Quota bytes (optional)" inputMode="numeric" value={s3Form.quotaBytes} onChange={(event) => setS3Form({ ...s3Form, quotaBytes: event.target.value })} />
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={s3Form.forcePathStyle} onChange={(event) => setS3Form({ ...s3Form, forcePathStyle: event.target.checked })} />Force path style</label>
          <div className="grid gap-3 sm:flex sm:justify-end"><Button variant="outline" type="button" onClick={() => setS3Open(false)} disabled={connectingS3}>Cancel</Button><Button type="submit" disabled={connectingS3}>{connectingS3 ? 'Connecting...' : 'Connect S3'}</Button></div>
        </form>
      </DummyModal>
      <DummyModal open={Boolean(accountToDisconnect)} title="Disconnect storage?" description="This will remove this storage account from 9Drive. Existing file records for this account may no longer be usable." onClose={() => setAccountToDisconnect(null)}>
        <div className="grid gap-4">
          <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-semibold text-slate-950">{accountToDisconnect?.email}</p>
            <p className="mt-1">Used storage: {formatBytes(accountToDisconnect?.storageAccount?.usedBytes)}</p>
          </div>
          <div className="grid gap-3 sm:flex sm:justify-end">
            <Button variant="outline" onClick={() => setAccountToDisconnect(null)} disabled={Boolean(disconnectingAccountId)}>Cancel</Button>
            <Button variant="danger" onClick={disconnect} disabled={Boolean(disconnectingAccountId)}><Trash2 className="h-4 w-4" />{disconnectingAccountId ? 'Disconnecting...' : 'Disconnect'}</Button>
          </div>
        </div>
      </DummyModal>
    </>
  )
}
