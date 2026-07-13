import { Router } from 'express'
import { prisma } from '../../config/prisma.js'
import { hashToken } from '../../utils/crypto.js'
import { streamProviderFile } from '../files/stream-file.js'

export const publicRouter = Router()

async function findSharedFile(token: string, password?: string) {
  const share = await prisma.fileShare.findFirst({
    where: { enabled: true, AND: [{ OR: [{ token }, { tokenHash: hashToken(token) }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }] },
    include: { file: { include: { connectedAccount: true } } },
  })
  if (!share || share.file.status !== 'active') throw new Error('Shared file not found')
  if (share.passwordHash) {
    if (!password) throw new Error('Password is required for this shared file.')
    const { verifyPassword } = await import('../../utils/password.js')
    if (!(await verifyPassword(share.passwordHash, password))) throw new Error('Incorrect password.')
  }
  return share.file
}

publicRouter.get('/files/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token)
    const password = req.query.password as string | undefined
    const file = await findSharedFile(token, password)
    return res.json({ file: { id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes.toString(), createdAt: file.createdAt } })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Password')) {
      return res.status(401).json({ code: 'PASSWORD_REQUIRED', message: error.message })
    }
    return next(error)
  }
})

publicRouter.get('/files/:token/download', async (req, res, next) => {
  try {
    const token = String(req.params.token)
    const password = req.query.password as string | undefined
    const file = await findSharedFile(token, password)
    return streamProviderFile(file, req.headers.range, res, { disposition: 'attachment' })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Password')) {
      return res.status(401).json({ code: 'PASSWORD_REQUIRED', message: error.message })
    }
    return next(error)
  }
})

publicRouter.get('/files/:token/preview', async (req, res, next) => {
  try {
    const token = String(req.params.token)
    const password = req.query.password as string | undefined
    const file = await findSharedFile(token, password)
    return streamProviderFile(file, req.headers.range, res, { disposition: 'inline' })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Password')) {
      return res.status(401).json({ code: 'PASSWORD_REQUIRED', message: error.message })
    }
    return next(error)
  }
})
