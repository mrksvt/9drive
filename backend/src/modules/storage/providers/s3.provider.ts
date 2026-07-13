import type { ConnectedAccount } from '@prisma/client'
import type { Response } from 'express'
import type { Readable } from 'node:stream'
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { prisma } from '../../../config/prisma.js'
import { decryptText } from '../../../utils/crypto.js'
import { syncS3Quota, buildS3ObjectKey, getS3ConfigForAccount, createS3Client } from '../../s3/s3.service.js'
import type { StorageProvider, ProviderFile, UploadResult, QuotaInfo, StreamOptions } from '../storage-provider.js'

export class S3Provider implements StorageProvider {
  readonly name = 's3'

  async upload(
    account: ConnectedAccount,
    fileName: string,
    mimeType: string,
    sizeBytes: bigint,
    stream: Readable,
    targetFolderId?: string
  ): Promise<UploadResult> {
    const config = await getS3ConfigForAccount(account.id)
    const provisionalFile = await prisma.file.create({
      data: {
        userId: account.userId,
        connectedAccountId: account.id,
        folderId: targetFolderId ?? null,
        provider: 's3',
        providerFileId: 'pending',
        name: fileName,
        mimeType,
        sizeBytes,
        status: 'uploading',
      },
    })

    const objectKey = buildS3ObjectKey(config, account.userId, provisionalFile.id, fileName)
    const client = createS3Client(config)
    await new Upload({
      client,
      params: { Bucket: config.bucket, Key: objectKey, Body: stream as Readable, ContentType: mimeType },
    }).done()

    await prisma.file.update({ where: { id: provisionalFile.id }, data: { providerFileId: objectKey, status: 'active' } })

    return { providerFileId: objectKey, name: fileName, mimeType }
  }

  async download(
    file: ProviderFile,
    range: string | undefined,
    res: Response,
    options: StreamOptions = {}
  ): Promise<void> {
    const { streamS3File } = await import('../../s3/s3.service.js')
    await streamS3File(file, range, res, options)
  }

  async delete(file: ProviderFile): Promise<void> {
    const config = await getS3ConfigForAccount(file.connectedAccountId)
    const client = createS3Client(config)
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }))
  }

  async getQuota(account: ConnectedAccount): Promise<QuotaInfo> {
    const storage = await syncS3Quota(account.id)
    return {
      totalBytes: storage.totalBytes ?? 0n,
      usedBytes: storage.usedBytes,
      availableBytes: storage.availableBytes ?? 0n,
      trashBytes: storage.trashBytes ?? 0n,
    }
  }

  async ensureAppFolder(_account: ConnectedAccount): Promise<string> {
    return ''
  }
}

export const s3Provider = new S3Provider()
