import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { checkNetwork } from '../../utils/network-check.js'

export const settingsRouter = Router()

settingsRouter.get('/network-status', requireAuth, async (_req: AuthRequest, res) => {
  const status = await checkNetwork()
  return res.json(status)
})
