import { Router } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { createOAuthClient, getAuthedGoogleClient } from '../google/google.service.js'
import { migrationService, subscribeMigration } from './migration.service.js'
import { scannerService } from './scanner.service.js'
import { migrationQueue } from './migration-queue-db.js'
import { crawlDriveFiles } from '../google/drive-scanner.js'
import { scanResultService } from '../mongodb/scan-result.service.js'

export const migrationRouter = Router()

migrationRouter.get('/source/callback', async (req, res, next) => {
  try {
    console.log('[MIGRATION-CALLBACK] received:', req.query)
    const query = z.object({ code: z.string(), state: z.string() }).parse(req.query)
    const oauthState = await prisma.oauthState.findUniqueOrThrow({
      where: { stateHash: hashToken(query.state) },
      include: { providerConfig: true },
    })
    if (oauthState.usedAt || oauthState.expiresAt < new Date()) {
      console.log('[MIGRATION-CALLBACK] state expired or used')
      return res.redirect(`${env.FRONTEND_URL}/migration?source=error&message=expired`)
    }
    if (oauthState.flow !== 'migration_source' || !oauthState.userId) {
      console.log('[MIGRATION-CALLBACK] invalid flow:', oauthState.flow)
      return res.redirect(`${env.FRONTEND_URL}/migration?source=error&message=invalid_flow`)
    }

    const client = createOAuthClient(oauthState.providerConfig)
    const callbackUrl = `${env.backendOrigin}/migrations/source/callback`
    console.log('[MIGRATION-CALLBACK] exchanging code with redirect_uri:', callbackUrl)
    const tokenResult = await client.getToken({ code: query.code, redirect_uri: callbackUrl })
    const tokens = tokenResult.tokens
    if (!tokens.access_token) {
      return res.redirect(`${env.FRONTEND_URL}/migration?source=error&message=no_token`)
    }
    client.setCredentials(tokens)
    const oauth2 = google.oauth2({ version: 'v2', auth: client })
    const profile = await oauth2.userinfo.get()
    const providerAccountId = profile.data.id
    const email = profile.data.email
    if (!providerAccountId || !email) {
      return res.redirect(`${env.FRONTEND_URL}/migration?source=error&message=no_profile`)
    }

    const existingAccount = await prisma.connectedAccount.findUnique({
      where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } },
    })
    const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
    if (!refreshTokenEncrypted) {
      return res.redirect(`${env.FRONTEND_URL}/migration?source=error&message=no_refresh`)
    }

    const account = await prisma.connectedAccount.upsert({
      where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } },
      create: {
        userId: oauthState.userId,
        providerConfigId: oauthState.providerConfigId,
        provider: 'google_drive',
        providerAccountId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'migration_source',
      },
      update: {
        providerConfigId: oauthState.providerConfigId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'migration_source',
      },
    })
    await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date() } })
    return res.redirect(`${env.FRONTEND_URL}/migration?source=connected&accountId=${account.id}`)
  } catch (error) {
    console.error('[MIGRATION-CALLBACK] ERROR:', error instanceof Error ? error.message : error)
    return res.redirect(`${env.FRONTEND_URL}/migration?source=error&message=unknown`)
  }
})

migrationRouter.get('/scan/:sourceAccountId/stream', async (req: AuthRequest, res, next) => {
  let keepalive: ReturnType<typeof setInterval> | null = null
  try {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    const send = (event: string, data: Record<string, unknown>) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n') } catch { /* ignore */ }
    }, 15_000)

    req.on('close', () => {
      if (keepalive) clearInterval(keepalive)
    })

    const token = req.query.token as string | undefined
    if (token) {
      const { verifyAccessToken } = await import('../../utils/jwt.js')
      let payload
      try { payload = verifyAccessToken(token) } catch {
        send('error', { message: 'Invalid token.' })
        res.end()
        return
      }
      const session = await prisma.userSession.findUnique({
        where: { id: payload.sid }
      })
      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        send('error', { message: 'Session expired.' })
        res.end()
        return
      }
      req.user = { id: payload.sub, sessionId: payload.sid }
    } else {
      const header = req.header('Authorization')
      if (!header?.startsWith('Bearer ')) {
        send('error', { message: 'Bearer token required.' })
        res.end()
        return
      }
      const { verifyAccessToken } = await import('../../utils/jwt.js')
      let payload
      try { payload = verifyAccessToken(header.slice(7)) } catch {
        send('error', { message: 'Invalid token.' })
        res.end()
        return
      }
      const session = await prisma.userSession.findUnique({
        where: { id: payload.sid }
      })
      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        send('error', { message: 'Session expired.' })
        res.end()
        return
      }
      req.user = { id: payload.sub, sessionId: payload.sid }
    }

    const sourceAccountId = String(req.params.sourceAccountId)
    const force = req.query.force === 'true'

    await scannerService.startScan(sourceAccountId, req.user!.id, {
      onStatus: (phase, message, migrationId) => {
        send('status', { phase, message, migrationId })
      },
      onProgress: (progress) => {
        send('progress', progress)
      },
      onItemsFound: (items) => {
        send('items-found', { items })
      },
      onComplete: (data) => {
        send('complete', data)
      },
      onError: (message) => {
        send('error', { message })
      }
    })

    clearInterval(keepalive!)
    res.end()
  } catch (error) {
    if (keepalive) clearInterval(keepalive)
    const msg = error instanceof Error ? error.message : 'Scan failed'
    res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`)
    res.end()
  }
})

migrationRouter.use(requireAuth)

migrationRouter.get('/scan/:sourceAccountId/status', async (req: AuthRequest, res, next) => {
  try {
    const sourceAccountId = String(req.params.sourceAccountId)
    const status = await scannerService.checkExistingScan(sourceAccountId, req.user!.id)
    return res.json(status)
  } catch (error) {
    return next(error)
  }
})

migrationRouter.get('/sources', async (req: AuthRequest, res, next) => {
  try {
    const sources = await scannerService.getSources(req.user!.id)
    return res.json({ sources })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.get('/source/connect-url', async (req: AuthRequest, res, next) => {
  try {
    const url = await scannerService.getSourceConnectUrl(req.user!.id)
    return res.json({ url })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.delete('/sources/:id', async (req: AuthRequest, res, next) => {
  try {
    await scannerService.removeSource(String(req.params.id), req.user!.id)
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.post('/preview', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ sourceAccountId: z.string().min(1) }).parse(req.body)
    const account = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: body.sourceAccountId, userId: req.user!.id, provider: 'google_drive', status: { in: ['connected', 'migration_source'] } },
    })

    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })

    const [about, crawlResult] = await Promise.all([
      drive.about.get({ fields: 'storageQuota' }),
      crawlDriveFiles(drive, undefined),
    ])

    const { items: crawled } = crawlResult
    const quota = about.data.storageQuota
    const sourceTotalBytes = quota?.limit ? Number(quota.limit) : null
    const sourceUsedBytes = quota?.usage ? Number(quota.usage) : 0

    const files = crawled.filter((i: any) => !i.isFolder && !i.isGoogleWorkspace)
    const folders = crawled.filter((i: any) => i.isFolder)
    const skipped = crawled.filter((i: any) => i.isGoogleWorkspace)
    const totalMigrateBytes = files.reduce((sum: number, f: any) => sum + f.size, 0)

    const byExtension: Record<string, { count: number; bytes: number }> = {}
    for (const file of files) {
      const lastDot = file.name.lastIndexOf('.')
      const ext = lastDot > 0 && lastDot < file.name.length - 1 ? file.name.slice(lastDot + 1).toLowerCase() : 'other'
      if (!byExtension[ext]) byExtension[ext] = { count: 0, bytes: 0 }
      byExtension[ext].count += 1
      byExtension[ext].bytes += file.size
    }

    const extensionBreakdown = Object.entries(byExtension)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([ext, data]) => ({ extension: ext, count: data.count, bytes: data.bytes }))

    return res.json({
      sourceAccount: { email: account.email, displayName: account.displayName },
      sourceTotalBytes,
      sourceUsedBytes,
      totalFiles: files.length,
      totalFolders: folders.length,
      skippedFiles: skipped.length,
      totalMigrateBytes,
      extensionBreakdown,
    })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const migrations = await migrationService.getList(req.user!.id)
    return res.json({ migrations })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const migration = await migrationService.getStatus(String(req.params.id), req.user!.id)
    return res.json({ migration })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.get('/:id/stream', async (req: AuthRequest, res, next) => {
  try {
    const migrationId = String(req.params.id)
    await migrationService.getStatus(migrationId, req.user!.id)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n') } catch { /* ignore */ }
    }, 15_000)

    const unsubscribe = subscribeMigration(migrationId, (event) => {
      if ('type' in event) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
      }
    })

    req.on('close', () => {
      clearInterval(keepalive)
      unsubscribe()
    })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.post('/:id/pause', async (req: AuthRequest, res, next) => {
  try {
    await migrationService.pause(String(req.params.id), req.user!.id)
    return res.json({ status: 'ok', message: 'Migration paused.' })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.post('/:id/resume', async (req: AuthRequest, res, next) => {
  try {
    await migrationService.resume(String(req.params.id), req.user!.id)
    return res.json({ status: 'ok', message: 'Migration resumed.' })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.delete('/batch', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ migrationIds: z.array(z.string().min(1)).min(1).max(100) }).parse(req.body)

    const owned = await prisma.migrationSession.findMany({
      where: { id: { in: body.migrationIds }, userId: req.user!.id },
      select: { id: true, status: true },
    })
    const ids = owned.map((s) => s.id)
    if (ids.length === 0) {
      return res.json({ status: 'ok', message: '0 migrations deleted.' })
    }

    for (const s of owned) {
      if (['pending', 'scanning', 'running', 'paused'].includes(s.status)) {
        await migrationQueue.cancel(s.id)
      }
    }

    const CHUNK = 5000
    for (const id of ids) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await prisma.migrationItem.findMany({ where: { migrationId: id }, select: { id: true }, take: CHUNK })
        if (batch.length === 0) break
        await prisma.migrationItem.deleteMany({ where: { id: { in: batch.map((b) => b.id) } } })
        if (batch.length < CHUNK) break
      }
    }

    await prisma.migrationSession.deleteMany({ where: { id: { in: ids } } })

    return res.json({ status: 'ok', message: `${ids.length} migration${ids.length === 1 ? '' : 's'} deleted.` })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    await migrationService.cancel(String(req.params.id), req.user!.id)
    return res.json({ status: 'ok', message: 'Migration cancelled.' })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.get('/:id/items', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    }).parse(req.query)

    const result = await migrationService.getItems(String(req.params.id), req.user!.id, query.page, query.limit)
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

migrationRouter.get('/:id/browse', async (req: AuthRequest, res, next) => {
  try {
    const migrationId = String(req.params.id)
    await prisma.migrationSession.findFirstOrThrow({ where: { id: migrationId, userId: req.user!.id } })

    const query = z.object({
      parentId: z.string().optional(),
      type: z.enum(['all', 'files', 'folders']).optional().default('all'),
      ext: z.string().optional(),
      search: z.string().optional(),
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    }).parse(req.query)

    const type = query.type === 'all' ? undefined : query.type === 'files' ? 'file' : 'folder'
    const status = query.type === 'all' ? undefined : query.type === 'files' ? 'pending' : 'pending'

    const result = await scanResultService.getByMigration(migrationId, {
      parentId: query.parentId ?? undefined,
      type,
      ext: query.ext,
      search: query.search,
      page: query.page,
      limit: query.limit,
      status: query.type === 'files' ? 'pending' : query.type === 'folders' ? 'pending' : undefined
    })

    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

migrationRouter.patch('/:id/items/select', async (req: AuthRequest, res, next) => {
  try {
    const migrationId = String(req.params.id)
    await prisma.migrationSession.findFirstOrThrow({ where: { id: migrationId, userId: req.user!.id, status: 'scanned' } })

    const body = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(1000).optional(),
      selectAll: z.boolean().optional(),
    }).parse(req.body)

    const result = await scanResultService.selectItems(migrationId, body.itemIds, body.selectAll)

    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

migrationRouter.patch('/:id/items/deselect', async (req: AuthRequest, res, next) => {
  try {
    const migrationId = String(req.params.id)
    await prisma.migrationSession.findFirstOrThrow({ where: { id: migrationId, userId: req.user!.id, status: 'scanned' } })

    const body = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(1000).optional(),
      deselectAll: z.boolean().optional(),
    }).parse(req.body)

    const result = await scanResultService.deselectItems(migrationId, body.itemIds, body.deselectAll)

    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

migrationRouter.post('/:id/start', async (req: AuthRequest, res, next) => {
  try {
    const migrationId = String(req.params.id)
    const migration = await prisma.migrationSession.findFirstOrThrow({
      where: { id: migrationId, userId: req.user!.id, status: 'scanned' },
    })

    const selectedCount = await prisma.migrationItem.count({ where: { migrationId, status: 'selected' } })
    if (selectedCount === 0) return res.status(400).json({ code: 'NO_ITEMS_SELECTED', message: 'No items selected for migration.' })

    await migrationService.startSelected(migrationId, req.user!.id)
    return res.json({ status: 'ok', message: `Migration started for ${selectedCount} items.` })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.post('/:id/retry-failed', async (req: AuthRequest, res, next) => {
  try {
    await migrationService.retryFailed(String(req.params.id), req.user!.id)
    return res.json({ status: 'ok', message: 'Retrying failed items.' })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.post('/:id/dry-run', async (req: AuthRequest, res, next) => {
  try {
    const dryRun = await migrationService.getDryRun(
      String(req.params.id),
      req.user!.id
    )
    return res.json(dryRun)
  } catch (error) {
    return next(error)
  }
})

migrationRouter.get('/:id/jobs', async (req: AuthRequest, res, next) => {
  try {
    const jobs = await migrationQueue.getJobStatus(String(req.params.id))
    return res.json({ jobs })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.post('/:id/jobs/retry', async (req: AuthRequest, res, next) => {
  try {
    const count = await migrationQueue.retryFailed(String(req.params.id))
    return res.json({ status: 'ok', message: `${count} jobs queued for retry.` })
  } catch (error) {
    return next(error)
  }
})
