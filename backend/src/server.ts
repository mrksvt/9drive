import { app } from './app.js'
import { env } from './config/env.js'
import { connectMongoDB, disconnectMongoDB } from './config/mongodb.js'
import { disconnectRedis, getRedisClient } from './config/redis.js'
import { prisma } from './config/prisma.js'

async function main() {
  await Promise.all([
    connectMongoDB(),
    getRedisClient().ping().then(() => console.log('[Redis] ping OK')),
  ])

  const server = app.listen(env.APP_PORT, () => {
    console.log(`Backend running on http://localhost:${env.APP_PORT}`)
  })

  server.requestTimeout = 600_000

  const shutdown = async (signal: string) => {
    console.log(`[Server] ${signal} received, shutting down...`)
    server.close()
    await Promise.allSettled([
      prisma.$disconnect(),
      disconnectMongoDB(),
      disconnectRedis(),
    ])
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('[Server] Failed to start:', err)
  process.exit(1)
})
