import type { ConnectedAccount } from '@prisma/client'
import type { StorageProvider } from './storage-provider.js'
import { googleDriveProvider } from './providers/google-drive.provider.js'
import { s3Provider } from './providers/s3.provider.js'

const providers: Record<string, StorageProvider> = {
  google_drive: googleDriveProvider,
  s3: s3Provider,
}

export function getStorageProvider(provider: string): StorageProvider {
  const p = providers[provider]
  if (!p) throw new Error(`Unknown storage provider: ${provider}`)
  return p
}

export function getProviderForAccount(account: ConnectedAccount): StorageProvider {
  return getStorageProvider(account.provider)
}

export function registerProvider(provider: StorageProvider): void {
  providers[provider.name] = provider
}
