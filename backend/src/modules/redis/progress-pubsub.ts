import { getRedisSubscriber, getRedisPublisher } from '../../config/redis.js'
import { MigrationEvent, ScanProgress } from '../migration/migration.service.js'

const subscriber = getRedisSubscriber()

// Shared subscription handler map: channel -> Set of callbacks
const handlers = new Map<string, Set<(event: MigrationEvent | ScanProgress) => void>>()

// Track active subscriptions to avoid duplicate subscriptions
const activeChannels = new Set<string>()

/**
 * Subscribe to a Redis channel and demux to registered handlers
 * Uses a single subscription per channel with handlers stored in the handlers map
 */
function subscribeToChannel(channel: string): void {
  if (activeChannels.has(channel)) {
    return
  }

  activeChannels.add(channel)

  subscriber.on('message', (subChannel: string, message: string) => {
    if (subChannel !== channel) return

    try {
      const data = JSON.parse(message) as MigrationEvent | ScanProgress
      const channelHandlers = handlers.get(channel)
      if (channelHandlers) {
        for (const cb of channelHandlers) {
          try { cb(data) } catch { /* ignore */ }
        }
      }
    } catch (err) {
      console.error(`[Redis] Error parsing message on ${channel}:`, err)
    }
  })

  subscriber.subscribe(channel, (err) => {
    if (err) {
      console.error(`[Redis] Failed to subscribe to ${channel}:`, err.message)
      activeChannels.delete(channel)
    }
  })
}

/**
 * Unsubscribe from a Redis channel when no more handlers remain
 */
function unsubscribeFromChannel(channel: string): void {
  const channelHandlers = handlers.get(channel)
  if (channelHandlers && channelHandlers.size === 0) {
    activeChannels.delete(channel)
    handlers.delete(channel)

    subscriber.unsubscribe(channel, (err) => {
      if (err) {
        console.error(`[Redis] Failed to unsubscribe from ${channel}:`, err.message)
      }
    })
  }
}

/**
 * Publish a migration event to the Redis channel
 */
export function publishMigrationEvent(migrationId: string, event: MigrationEvent): void {
  const publisher = getRedisPublisher()
  const channel = `migration:${migrationId}`
  publisher.publish(channel, JSON.stringify(event))
}

/**
 * Publish scan progress to the Redis channel
 */
export function publishScanProgress(migrationId: string, progress: ScanProgress): void {
  const publisher = getRedisPublisher()
  const channel = `scan:${migrationId}`
  publisher.publish(channel, JSON.stringify(progress))
}

/**
 * Subscribe to migration events for a specific migration
 * Returns an unsubscribe function
 */
export function subscribeMigration(
  migrationId: string,
  callback: (event: MigrationEvent | ScanProgress) => void
): () => void {
  const channel = `migration:${migrationId}`

  if (!handlers.has(channel)) {
    handlers.set(channel, new Set())
    subscribeToChannel(channel)
  }

  handlers.get(channel)!.add(callback)

  return () => {
    const channelHandlers = handlers.get(channel)
    if (channelHandlers) {
      channelHandlers.delete(callback)
      unsubscribeFromChannel(channel)
    }
  }
}
