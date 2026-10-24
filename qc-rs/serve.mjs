#!/usr/bin/env node
// Serves the VITE_BACKEND=rust build for the QC flows, proxying /api to the
// Rust server over kept-alive connections.
//
//   node qc-rs/serve.mjs [--dir dist-qc-rs] [--port 4300] [--api http://127.0.0.1:8787]
//
// Why not `vite preview`: its proxy opens a new TCP connection to the API
// for every request, so with netem's 30 ms RTT on :8787 each call pays a
// handshake as well (~64 ms instead of ~33). A deployed SPA keeps its
// connection to the API open (as Convex keeps its WebSocket), so this
// proxy does too.
import { createReadStream, existsSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? dflt : process.argv[i + 1]
}
const dir = path.resolve(arg('dir', 'dist-qc-rs'))
const port = Number(arg('port', process.env.QC_RS_PORT ?? 4300))
const api = new URL(arg('api', process.env.KEEP_API ?? 'http://127.0.0.1:8787'))
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
      const up = http.request(
        {
          host: api.hostname,
          port: api.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: api.host },
          agent,
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers)
          r.pipe(res)
        },
      )
      up.on('error', (e) => {
        res.writeHead(502)
        res.end(String(e))
      })
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
    console.log(`qc-rs: ${dir} on http://localhost:${port}, /api → ${api}`),
  )
