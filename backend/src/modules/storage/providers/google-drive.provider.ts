import type { ConnectedAccount } from '@prisma/client'
import type { Response } from 'express'
import type { Readable } from 'node:stream'
import { google } from 'googleapis'
import { getAuthedGoogleClient, ensureGoogleAppFolder, syncGoogleQuota } from '../../google/google.service.js'
import type { StorageProvider, ProviderFile, UploadResult, QuotaInfo, StreamOptions } from '../storage-provider.js'

export class GoogleDriveProvider implements StorageProvider {
  readonly name = 'google_drive'

  async upload(
    account: ConnectedAccount,
    fileName: string,
    mimeType: string,
    sizeBytes: bigint,
    stream: Readable,
    targetFolderId?: string
  ): Promise<UploadResult> {
    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })
    const appFolderId = targetFolderId ?? await this.ensureAppFolder(account)

    const uploaded = await drive.files.create({
      requestBody: { name: fileName, parents: [appFolderId] },
      media: { mimeType, body: stream },
      fields: 'id,name,mimeType,size',
    })

    return {
      providerFileId: uploaded.data.id ?? '',
      name: uploaded.data.name ?? fileName,
      mimeType: uploaded.data.mimeType ?? mimeType,
    }
  }

  async download(
    file: ProviderFile,
    range: string | undefined,
    res: Response,
    options: StreamOptions = {}
  ): Promise<void> {
    const { streamGoogleFile } = await import('../../files/stream-google-file.js')
    await streamGoogleFile(file, range, res, options)
  }

  async delete(file: ProviderFile): Promise<void> {
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    const drive = google.drive({ version: 'v3', auth })
    await drive.files.delete({ fileId: file.providerFileId })
  }

  async getQuota(account: ConnectedAccount): Promise<QuotaInfo> {
    const storage = await syncGoogleQuota(account.id)
    return {
      totalBytes: storage.totalBytes ?? 0n,
      usedBytes: storage.usedBytes,
      availableBytes: storage.availableBytes ?? 0n,
      trashBytes: storage.trashBytes ?? 0n,
    }
  }

  async ensureAppFolder(account: ConnectedAccount): Promise<string> {
    return ensureGoogleAppFolder(account)
  }
}

export const googleDriveProvider = new GoogleDriveProvider()
