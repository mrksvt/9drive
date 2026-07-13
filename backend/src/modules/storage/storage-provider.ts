import type { ConnectedAccount, File } from '@prisma/client'
import type { Response } from 'express'
import type { Readable } from 'node:stream'

export type StreamOptions = { disposition?: 'inline' | 'attachment' }

export type ProviderFile = File & { connectedAccount: ConnectedAccount }

export type UploadResult = {
  providerFileId: string
  name: string
  mimeType: string
}

export type QuotaInfo = {
  totalBytes: bigint
  usedBytes: bigint
  availableBytes: bigint
  trashBytes: bigint
}

export interface StorageProvider {
  readonly name: string

  upload(
    account: ConnectedAccount,
    fileName: string,
    mimeType: string,
    sizeBytes: bigint,
    stream: Readable,
    targetFolderId?: string
  ): Promise<UploadResult>

  download(
    file: ProviderFile,
    range: string | undefined,
    res: Response,
    options?: StreamOptions
  ): Promise<void>

  delete(file: ProviderFile): Promise<void>

  getQuota(account: ConnectedAccount): Promise<QuotaInfo>

  ensureAppFolder(account: ConnectedAccount): Promise<string>
}
