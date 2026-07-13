import mongoose from 'mongoose'
import { env } from './env.js'

let isConnected = false

export async function connectMongoDB(): Promise<typeof mongoose> {
  if (isConnected && mongoose.connection.readyState === 1) {
    return mongoose
  }

  mongoose.set('strictQuery', true)

  mongoose.connection.on('connected', () => {
    isConnected = true
    console.log('[MongoDB] connected')
  })

  mongoose.connection.on('error', (err) => {
    console.error('[MongoDB] connection error:', err.message)
  })

  mongoose.connection.on('disconnected', () => {
    isConnected = false
    console.warn('[MongoDB] disconnected')
  })

  await mongoose.connect(env.MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    family: 4,
  })

  return mongoose
}

export async function disconnectMongoDB(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close()
    isConnected = false
    console.log('[MongoDB] connection closed')
  }
}

export function mongoHealthCheck(): { status: string; readyState: number } {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting']
  return {
    status: states[mongoose.connection.readyState] ?? 'unknown',
    readyState: mongoose.connection.readyState,
  }
}
