#!/usr/bin/env node
// Serves the SPA build for the QC flows (one per pool instance,
// playwright.config.ts), proxying /api to that instance's api over
// kept-alive connections, as the api itself does when hosted (one origin).
//
//   node qc/serve.mjs [--dir dist-qc] [--port 4301] [--api http://127.0.0.1:8801]
//
// Why not `vite preview`: its proxy opens a new TCP connection to the API
// for every request, so under netem's RTT on the api's port each call pays
// a handshake as well (~64 ms instead of ~33 at 30 ms). A browser keeps
// its connection to the API open, so this proxy does too. The change
// stream (`…/events`) is long-lived, so it gets a connection of its own
// rather than holding one of the pool's.
import { createReadStream, existsSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? dflt : process.argv[i + 1]
}
const dir = path.resolve(arg('dir', 'dist-qc'))
const port = Number(arg('port', 4301))
const api = new URL(arg('api', 'http://127.0.0.1:8801'))
const agent = new http.Agent({ keepAlive: true, maxSockets: 16 })

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

http
  .createServer((req, res) => {
    if (req.url.startsWith('/api/') || req.url === '/api') {
      const stream = /\/events(\?|$)/.test(req.url)
      const up = http.request(
        {
          host: api.hostname,
          port: api.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: api.host },
          agent: stream ? false : agent,
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers)
          r.pipe(res)
        },
      )
      up.on('error', (e) => {
        if (res.headersSent) return res.destroy()
        res.writeHead(502)
        res.end(String(e))
      })
      // A tab that closes its event stream closes the api's end too
      // (never a pooled request: that would drop a kept-alive socket).
      if (stream) res.on('close', () => up.destroy())
      req.pipe(up)
      return
    }
    const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]))
    const file =
      p.startsWith(dir) && existsSync(p) && statSync(p).isFile()
        ? p
        : path.join(dir, 'index.html')
    res.writeHead(200, {
      'content-type': types[path.extname(file)] ?? 'application/octet-stream',
    })
    createReadStream(file).pipe(res)
  })
  .listen(port, 'localhost', () =>
    console.log(`qc: ${dir} on http://localhost:${port}, /api → ${api}`),
  )
