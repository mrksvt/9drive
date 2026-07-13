import { describe, it, expect, vi } from 'vitest'
import { fileRouter } from '../src/modules/files/file.routes.js'
import { prisma } from '../src/config/prisma.js'
import request from 'supertest'
import { app } from '../src/app.js'

describe('Password Protection Share Token', () => {
  it('should create share with password', async () => {
    vi.mocked(prisma.file.findFirstOrThrow).mockResolvedValue({
      id: 'file1',
      userId: 'user1',
      status: 'active',
    })
    vi.mocked(prisma.fileShare.create).mockResolvedValue({
      id: 'share1',
      fileId: 'file1',
      userId: 'user1',
      token: 'share-token',
      passwordHash: 'hashed:password',
    })

    const response = await request(app)
      .post('/files/file1/share')
      .set('Authorization', 'Bearer valid-token')
      .send({ password: 'password' })

    expect(response.status).toBe(201)
    expect(response.body.url).toContain('share-token')
  })

  it('should reject access without password', async () => {
    vi.mocked(prisma.fileShare.findFirst).mockResolvedValue({
      id: 'share1',
      fileId: 'file1',
      userId: 'user1',
      token: 'share-token',
      passwordHash: 'hashed:password',
      file: { id: 'file1', status: 'active' },
    })

    const response = await request(app)
      .get('/public/files/share-token')

    expect(response.status).toBe(401)
    expect(response.body.code).toBe('PASSWORD_REQUIRED')
  })

  it('should reject access with wrong password', async () => {
    vi.mocked(prisma.fileShare.findFirst).mockResolvedValue({
      id: 'share1',
      fileId: 'file1',
      userId: 'user1',
      token: 'share-token',
      passwordHash: 'hashed:password',
      file: { id: 'file1', status: 'active' },
    })

    const response = await request(app)
      .get('/public/files/share-token?password=wrong')

    expect(response.status).toBe(401)
    expect(response.body.code).toBe('PASSWORD_REQUIRED')
  })

  it('should allow access with correct password', async () => {
    vi.mocked(prisma.fileShare.findFirst).mockResolvedValue({
      id: 'share1',
      fileId: 'file1',
      userId: 'user1',
      token: 'share-token',
      passwordHash: 'hashed:password',
      file: {
        id: 'file1',
        status: 'active',
        name: 'test.pdf',
        mimeType: 'application/pdf',
        sizeBytes: '1024',
        createdAt: new Date(),
      },
    })

    const response = await request(app)
      .get('/public/files/share-token?password=password')

    expect(response.status).toBe(200)
    expect(response.body.file.name).toBe('test.pdf')
  })
})