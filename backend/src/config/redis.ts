import Redis from 'ioredis'
import { env } from './env.js'

const baseOpts = {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    if (times > 10) return null
    return Math.min(times * 200, 5000)
  },
  enableReadyCheck: true,
  lazyConnect: false,
}

let _client: Redis | null = null
let _sub: Redis | null = null
let _pub: Redis | null = null

export function getRedisClient(): Redis {
  if (!_client) {
    _client = new Redis(env.REDIS_URL, { ...baseOpts, keyPrefix: '9drive:' })
    _client.on('error', (err) => console.error('[Redis] client error:', err.message))
    _client.on('connect', () => console.log('[Redis] client connected'))
  }
  return _client
}

export function getRedisSubscriber(): Redis {
  if (!_sub) {
    _sub = new Redis(env.REDIS_URL, baseOpts)
    _sub.on('error', (err) => console.error('[Redis] sub error:', err.message))
  }
  return _sub
}

export function getRedisPublisher(): Redis {
  if (!_pub) {
    _pub = new Redis(env.REDIS_URL, { ...baseOpts, keyPrefix: '9drive:' })
    _pub.on('error', (err) => console.error('[Redis] pub error:', err.message))
  }
  return _pub
}

export async function disconnectRedis(): Promise<void> {
  await Promise.allSettled([
    _client?.quit(),
    _sub?.quit(),
    _pub?.quit(),
  ])
  _client = _sub = _pub = null
  console.log('[Redis] all connections closed')
}

export function redisHealthCheck(): { status: string; ping?: string } {
  if (!_client) return { status: 'not_initialized' }
  const status = _client.status
  return { status }
}
