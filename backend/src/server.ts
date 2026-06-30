import { app } from './app.js'
import { env } from './config/env.js'

const server = app.listen(env.APP_PORT, () => {
  console.log(`Backend running on http://localhost:${env.APP_PORT}`)
})

server.requestTimeout = 600_000
