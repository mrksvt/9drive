import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'

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

const CELLULAR_INTERFACE_PATTERNS = [/^wwan\d/i, /^usb\d+$/, /^enx[0-9a-f]{12}$/i, /^eth\d+$/]
const TUNNEL_INTERFACE_PATTERNS = [/^tun\d/i, /^tap\d/i, /^wg\d/i, /^cloudflare-warp$/i, /^tailscale\d$/i, /^ztsigbus$/i, /^zt[0-9a-f]+$/i]
const NMCLI_CELLULAR_TYPES = ['gsm', 'cdma', 'bluetooth']

const CARRIER_ASNS = new Set([
  '23693', '45296',
  '4761', '17974',
  '24203', '17826',
  '45725', '23951',
  '131706',
  '55660', '55661',
  '38750', '58496',
  '138822',
])

const CARRIER_ORG_KEYWORDS = [
  'telkomsel', 'pt telekomunikasi selular',
  'indosat', 'pt indosat', 'indosat tbk',
  'xl axiata', 'pt excelcomindo',
  'tri indonesia', 'pt hutchison', 'hutchison',
  'smartfren', 'pt smartfren', 'smart telecom',
  'by.u', 'byu',
]

function getDefaultInterface(): string | null {
  try {
    const route = execFileSync('ip', ['route', 'show', 'default'], { encoding: 'utf8', timeout: 3000 }).trim()
    const match = route.match(/dev\s+(\S+)/)
    if (match) return match[1]
  } catch { /* ignore */ }

  try {
    const procRoute = readFileSync('/proc/net/route', 'utf8')
    for (const line of procRoute.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols[1] === '00000000' && cols[7] === '00000000') return cols[0]
    }
  } catch { /* ignore */ }

  return null
}

function getNmcliConnectionType(): { type: string; name: string } | null {
  try {
    const output = execFileSync('nmcli', ['-t', '-f', 'NAME,TYPE,DEVICE', 'con', 'show', '--active'], { encoding: 'utf8', timeout: 3000 }).trim()
    for (const line of output.split('\n')) {
      const [name, type, device] = line.split(':')
      if (type && device) return { type: type.toLowerCase(), name: name ?? '' }
    }
  } catch { /* ignore */ }
  return null
}

function isCellularInterface(iface: string): boolean {
  return CELLULAR_INTERFACE_PATTERNS.some((p) => p.test(iface))
}

function isTunnelInterface(iface: string): boolean {
  return TUNNEL_INTERFACE_PATTERNS.some((p) => p.test(iface))
}

function getInterfaceDriver(iface: string): string | null {
  try {
    const uevent = readFileSync(`/sys/class/net/${iface}/device/uevent`, 'utf8')
    const match = uevent.match(/DRIVER=(.+)/)
    if (match) return match[1].trim().toLowerCase()
  } catch { /* ignore */ }
  return null
}

function isWirelessInterface(iface: string): boolean {
  if (existsSync(`/sys/class/net/${iface}/wireless`)) return true
  try { if (existsSync(`/sys/class/net/${iface}/phy80211`)) return true } catch { /* ignore */ }
  return false
}

type IpInfo = { ip: string; org: string; hostname: string; query?: string; isp?: string }

function fetchJson(url: string, timeoutMs = 4000): Promise<IpInfo | null> {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return }
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

async function getPublicIpInfo(): Promise<IpInfo | null> {
  const sources = [
    'https://ipinfo.io/json',
    'http://ip-api.com/json/?fields=query,isp,org',
  ]

  for (const url of sources) {
    try {
      const raw = await fetchJson(url)
      if (!raw) continue

      if (url.includes('ipinfo.io')) {
        if (raw.ip) return { ip: raw.ip, org: raw.org ?? '', hostname: raw.hostname ?? '' }
      } else if (url.includes('ip-api.com')) {
        if (raw.query) return { ip: raw.query, org: raw.org ?? raw.isp ?? '', hostname: '' }
      }
    } catch { /* ignore */ }
  }
  return null
}

function parseAsn(org: string): string | null {
  const match = org.match(/AS(\d+)/)
  return match ? match[1] : null
}

function isCarrierOrg(org: string): boolean {
  const lower = org.toLowerCase()
  return CARRIER_ORG_KEYWORDS.some((keyword) => lower.includes(keyword))
}

function isCarrierAsn(asn: string | null): boolean {
  if (!asn) return false
  return CARRIER_ASNS.has(asn)
}

const TUNNEL_ASNS = new Set(['13335', '14061', '16276', '36459', '209242', '212238', '60068'])

function isTunnelAsn(asn: string | null, org: string): boolean {
  if (asn && TUNNEL_ASNS.has(asn)) return true
  const lower = org.toLowerCase()
  return lower.includes('cloudflare') || lower.includes('tailscale') || lower.includes('mullvad') || lower.includes('wireguard')
}

function detectFromLocalInterface(iface: string): { connectionType: NetworkStatus['connectionType']; driver: string | null } {
  const nmcli = getNmcliConnectionType()
  const driver = getInterfaceDriver(iface)
  const isWireless = isWirelessInterface(iface)
  const isCellular = isCellularInterface(iface)
  const isTunnel = isTunnelInterface(iface)

  if (isTunnel) return { connectionType: 'tunnel', driver }

  let connectionType: NetworkStatus['connectionType'] = 'unknown'

  if (nmcli) {
    const nmType = nmcli.type
    if (NMCLI_CELLULAR_TYPES.includes(nmType)) connectionType = 'cellular'
    else if (nmType === 'wifi' || nmType === '802-11-wireless') connectionType = 'wifi'
    else if (nmType === '802-3-ethernet' || nmType === 'ethernet') connectionType = 'ethernet'
    else if (nmType === 'bridge') {
      if (isCellular || (driver && ['cdc_ether', 'rndis_host', 'cdc_ncm', 'cdc_mbim'].includes(driver))) connectionType = 'tethered'
      else if (isWireless) connectionType = 'wifi'
      else connectionType = 'ethernet'
    }
  }

  if (connectionType === 'unknown') {
    if (isCellular) connectionType = 'cellular'
    else if (isWireless) connectionType = 'wifi'
    else if (driver && ['cdc_ether', 'rndis_host', 'cdc_ncm', 'cdc_mbim'].includes(driver)) connectionType = 'tethered'
    else connectionType = 'ethernet'
  }

  return { connectionType, driver }
}

export async function checkNetwork(): Promise<NetworkStatus> {
  const iface = getDefaultInterface()

  if (!iface) {
    return {
      interface: 'none', connectionType: 'unknown', isMetered: false,
      warning: 'Tidak dapat mendeteksi jaringan aktif.',
      details: 'Tidak ada koneksi jaringan yang terdeteksi.',
      publicIp: null, isp: null, carrierDetected: false,
    }
  }

  const local = detectFromLocalInterface(iface)
  const ipInfo = await getPublicIpInfo()

  let connectionType = local.connectionType
  let carrierDetected = false
  let warning: string | null = null

  if (ipInfo) {
    const asn = parseAsn(ipInfo.org)
    const isCarrier = isCarrierAsn(asn) || isCarrierOrg(ipInfo.org)
    const isTunnel = isTunnelAsn(asn, ipInfo.org)

    if (isTunnel && local.connectionType !== 'cellular') {
      connectionType = 'tunnel'
      carrierDetected = false
    } else if (isCarrier) {
      carrierDetected = true
      if (connectionType === 'wifi' || connectionType === 'ethernet') {
        connectionType = 'tethered'
      }
    }
  }

  const isMetered = connectionType === 'cellular' || connectionType === 'tethered'

  if (connectionType === 'cellular') {
    warning = 'Anda terhubung via koneksi seluler (kuota internet SIM). Upload/download/migrasi akan menghabiskan kuota data Anda.'
  } else if (connectionType === 'tethered' && carrierDetected) {
    warning = `Anda terhubung via WiFi/tethering namun IP Publik terdeteksi dari operator seluler (${ipInfo?.org ?? 'carrier'}). Kemungkinan besar menggunakan kuota data.`
  } else if (connectionType === 'tethered') {
    warning = 'Anda terhubung via tethering/USB. Koneksi ini mungkin menggunakan kuota data seluler.'
  } else if (connectionType === 'tunnel') {
    warning = 'Anda terhubung via VPN/tunnel. Tipe koneksi asli tidak dapat dideteksi. Hati-hati jika koneksi asli adalah seluler.'
  }

  const detailsMap: Record<string, string> = {
    wifi: 'WiFi — koneksi unlimited (bukan kuota seluler).',
    ethernet: 'Ethernet — koneksi kabel, aman untuk transfer besar.',
    cellular: 'Seluler (SIM/WWAN) — menggunakan kuota internet. Hati-hati!',
    tethered: carrierDetected
      ? `Tethering — IP Publik dari operator seluler (${ipInfo?.org ?? 'carrier'}). Menggunakan kuota!`
      : 'Tethering/USB — kemungkinan menggunakan kuota seluler.',
    tunnel: 'VPN/Tunnel — tipe koneksi asli tersembunyi di balik tunnel.',
    unknown: 'Tipe koneksi tidak dikenali.',
  }

  return {
    interface: iface,
    connectionType,
    isMetered,
    warning,
    details: `${detailsMap[connectionType]} Interface: ${iface}${local.driver ? ` (${local.driver})` : ''}${ipInfo ? ` | IP: ${ipInfo.ip} (${ipInfo.org})` : ''}`,
    publicIp: ipInfo?.ip ?? null,
    isp: ipInfo?.org ?? null,
    carrierDetected,
  }
}
