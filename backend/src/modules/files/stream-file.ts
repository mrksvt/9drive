import type { ConnectedAccount, File } from '@prisma/client'
import type { Response } from 'express'
import { getProviderForAccount } from '../storage/storage-provider.factory.js'

type FileWithAccount = File & { connectedAccount: ConnectedAccount }
type StreamOptions = { disposition?: 'inline' | 'attachment' }

export function streamProviderFile(file: FileWithAccount, range: string | undefined, res: Response, options: StreamOptions = {}) {
  const provider = getProviderForAccount(file.connectedAccount)
  return provider.download(file, range, res, options)
}
