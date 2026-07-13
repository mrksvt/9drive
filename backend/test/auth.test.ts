import { describe, it, expect, vi } from 'vitest'
import { authRouter } from '../src/modules/auth/auth.routes.js'
import { prisma } from '../src/config/prisma.js'
import request from 'supertest'
import { app } from '../src/app.js'

describe('reCAPTCHA Enforcement', () => {
  it('should reject register without captcha', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.user.create).mockResolvedValue({
      id: 'user1',
      name: 'Test User',
      email: 'test@example.com',
      passwordHash: 'hashed:password',
    })

    const response = await request(app)
      .post('/auth/register')
      .send({ name: 'Test User', email: 'test@example.com', password: 'password' })

    expect(response.status).toBe(400)
    expect(response.body.code).toBe('CAPTCHA_FAILED')
  })

  it('should allow register with captcha', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.user.create).mockResolvedValue({
      id: 'user1',
      name: 'Test User',
      email: 'test@example.com',
      passwordHash: 'hashed:password',
    })

    const response = await request(app)
      .post('/auth/register')
      .send({
        name: 'Test User',
        email: 'test@example.com',
        password: 'password',
        captchaToken: 'valid-token'
      })

    expect(response.status).toBe(201)
    expect(response.body.user.email).toBe('test@example.com')
  })
})