const STORAGE_KEY = '9drive:network-settings'

export type NetworkSettings = {
  allowCellular: boolean
  allowTethered: boolean
}

const defaults: NetworkSettings = {
  allowCellular: false,
  allowTethered: false,
}

export function getNetworkSettings(): NetworkSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw)
    return {
      allowCellular: Boolean(parsed.allowCellular),
      allowTethered: Boolean(parsed.allowTethered),
    }
  } catch {
    return defaults
  }
}

export function setNetworkSettings(settings: NetworkSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function isTransferAllowed(connectionType: string, settings?: NetworkSettings): boolean {
  const s = settings ?? getNetworkSettings()
  if (connectionType === 'cellular') return s.allowCellular
  if (connectionType === 'tethered') return s.allowTethered
  return true
}

export function getBlockMessage(connectionType: string): string {
  if (connectionType === 'cellular') {
    return 'Transfer diblokir karena Anda menggunakan koneksi seluler (kuota SIM). Aktifkan "Izinkan Kuota Seluler" di Settings untuk melanjutkan.'
  }
  if (connectionType === 'tethered') {
    return 'Transfer diblokir karena Anda menggunakan tethering/USB. Aktifkan "Izinkan Tethering" di Settings untuk melanjutkan.'
  }
  return 'Transfer tidak diizinkan pada koneksi ini.'
}
