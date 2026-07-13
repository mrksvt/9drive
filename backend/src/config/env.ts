import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/9drive'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  APP_PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().url(),
  BACKEND_URL: z.string().url().optional(),
  EXTRA_CORS_ORIGINS: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  MAX_UPLOAD_BYTES: z.coerce.number().default(5 * 1024 * 1024 * 1024),
  RECAPTCHA_SECRET_KEY: z.string().optional(),
})

const parsed = envSchema.parse(process.env)

export const env = {
  ...parsed,
  backendOrigin: parsed.BACKEND_URL ?? `http://localhost:${parsed.APP_PORT}`,
}
