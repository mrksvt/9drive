import cors from 'cors'
import express from 'express'
import { env } from './config/env.js'
import { errorMiddleware } from './middleware/error.middleware.js'
import { apiLimiter, authLimiter, uploadLimiter } from './middleware/rate-limit.middleware.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { providerConfigRouter } from './modules/provider-configs/provider-config.routes.js'
import { connectedAccountRouter } from './modules/connected-accounts/connected-account.routes.js'
import { storageRouter } from './modules/storage/storage.routes.js'
import { uploadRouter } from './modules/uploads/upload.routes.js'
import { fileRouter } from './modules/files/file.routes.js'
import { folderRouter } from './modules/folders/folder.routes.js'
import { publicRouter } from './modules/public/public.routes.js'
import { inviteRouter } from './modules/invites/invite.routes.js'
import { apiKeyRouter } from './modules/api-keys/api-key.routes.js'
import { publicApiRouter } from './modules/public-api/public-api.routes.js'
import { migrationRouter } from './modules/migration/migration.routes.js'
import { settingsRouter } from './modules/settings/settings.routes.js'

export const app = express()
app.set('trust proxy', 1)

const extraOrigins = env.EXTRA_CORS_ORIGINS
  ? env.EXTRA_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : []

const allowedOrigins = [env.FRONTEND_URL, ...extraOrigins]

app.use(cors({ origin: allowedOrigins }))
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => res.json({ status: 'ok' }))
app.use('/api', apiLimiter, publicApiRouter)
app.use('/public', publicRouter)
app.use('/auth', authLimiter, authRouter)
app.use('/api-keys', apiLimiter, apiKeyRouter)
app.use('/provider-configs', apiLimiter, providerConfigRouter)
app.use('/connected-accounts', apiLimiter, connectedAccountRouter)
app.use('/storage', apiLimiter, storageRouter)
app.use('/uploads', uploadLimiter, uploadRouter)
app.use('/files', apiLimiter, fileRouter)
app.use('/folders', apiLimiter, folderRouter)
app.use('/invites', apiLimiter, inviteRouter)
app.use('/migrations', apiLimiter, migrationRouter)
app.use('/settings', apiLimiter, settingsRouter)
app.use(errorMiddleware)
