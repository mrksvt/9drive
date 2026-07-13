import { vi } from 'vitest'
import { prisma } from '../src/config/prisma.js'
import { google } from 'googleapis'

// Mock Prisma
vi.mock('../src/config/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    fileShare: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    connectedAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

// Mock Google API
vi.mock('googleapis', () => ({
  google: {
    drive: vi.fn(() => ({
      files: {
        get: vi.fn(),
      },
    })),
  },
}))

// Mock reCAPTCHA
vi.mock('../src/utils/captcha.js', () => ({
  verifyCaptcha: vi.fn(() => Promise.resolve(true)),
}))

// Mock auth utils
vi.mock('../src/utils/auth.js', () => ({
  hashPassword: vi.fn((p) => Promise.resolve(`hashed:${p}`)),
  verifyPassword: vi.fn((h, p) => Promise.resolve(h === `hashed:${p}`)),
}))