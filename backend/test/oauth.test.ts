import { describe, it, expect, vi } from 'vitest'
import { connectedAccountRouter } from '../src/modules/connected-accounts/connected-account.routes.js'
import { prisma } from '../src/config/prisma.js'
import request from 'supertest'
import { app } from '../src/app.js'

describe('Google OAuth Confirmation', () => {
  it('should create unconfirmed account on connect', async () => {
    vi.mocked(prisma.connectedAccount.upsert).mockResolvedValue({
      id: 'account1',
      userId: 'user1',
      provider: 'google_drive',
      email: 'test@gmail.com',
      confirmedAt: null,
    })

    const response = await request(app)
      .post('/connected-accounts/account1/confirm')
      .set('Authorization', 'Bearer valid-token')

    expect(response.status).toBe(200)
    expect(vi.mocked(prisma.connectedAccount.update).mock.calls[0][0].data.confirmedAt).toBeDefined()
  })

  it('should confirm account', async () => {
    vi.mocked(prisma.connectedAccount.update).mockResolvedValue({
      id: 'account1',
      userId: 'user1',
      provider: 'google_drive',
      email: 'test@gmail.com',
      confirmedAt: new Date(),
    })

    const response = await request(app)
      .post('/connected-accounts/account1/confirm')
      .set('Authorization', 'Bearer valid-token')

    expect(response.status).toBe(200)
    expect(response.body.account.confirmed).toBe(true)
  })
})