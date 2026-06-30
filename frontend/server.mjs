import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, 'dist')
const PORT = 5173

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

const server = http.createServer((req, res) => {
  let filePath = path.join(distDir, req.url === '/' ? 'index.html' : req.url)
  const ext = path.extname(filePath)
  
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA fallback
      filePath = path.join(distDir, 'index.html')
    }
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500)
        res.end('Internal Server Error')
        return
      }
      const mime = MIME[path.extname(filePath)] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime })
      res.end(data)
    })
  })
})

server.listen(PORT, () => console.log(`Frontend static server on http://localhost:${PORT}`))
