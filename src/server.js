import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseProxyTarget, proxyRequest, proxyUpgrade, probeFrameable } from './proxy.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = path.join(ROOT, 'public')

const ASSETS = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/shim.js': ['shim.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', ''])

function hostName(value) {
  if (!value) return ''
  return value.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
}

export async function startServer({ panes, orientation = 'row', host = '127.0.0.1', preferredPort = 4747 }) {
  const config = { panes, orientation, port: null }
  let boundPort = null

  const guardHost = host === '127.0.0.1' || host === 'localhost' || host === '::1'

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('Internal error')
    })
  })

  server.on('upgrade', (req, socket, head) => {
    let parsed
    try {
      const url = new URL(req.url, 'http://localhost')
      parsed = parseProxyTarget(url.pathname, url.search)
    } catch {
      parsed = null
    }
    if (!parsed) {
      socket.destroy()
      return
    }
    proxyUpgrade(req, socket, head, parsed)
  })

  async function handle(req, res) {
    if (guardHost) {
      const name = hostName(req.headers.host)
      if (!LOOPBACK_NAMES.has(name) && !name.endsWith('.localhost')) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('Forbidden host')
        return
      }
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const { pathname } = url

    if (pathname.startsWith('/p/')) {
      const parsed = parseProxyTarget(pathname, url.search)
      if (!parsed) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('Bad proxy path')
        return
      }
      await proxyRequest(req, res, parsed)
      return
    }

    if (pathname === '/api/probe') {
      await handleProbe(url, res)
      return
    }

    if (pathname === '/' || pathname === '/index.html') {
      const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
      const payload = JSON.stringify(config).replace(/</g, '\\u003c')
      const body = html.replace('__SBS_CONFIG__', payload)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
      return
    }

    const asset = ASSETS[pathname]
    if (asset) {
      const [file, type] = asset
      const body = await readFile(path.join(PUBLIC_DIR, file))
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found')
  }

  async function handleProbe(url, res) {
    const target = url.searchParams.get('url')
    const send = (payload, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }

    if (!target) return send({ ok: false, frameable: true, reason: 'Missing url' }, 400)

    let parsedTarget
    try {
      const u = new URL(target)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol')
      parsedTarget = u.href
    } catch {
      return send({ ok: false, frameable: true, reason: 'Invalid URL' }, 400)
    }

    const result = await probeFrameable(parsedTarget)
    send({
      ...result,
      reason: result.ok ? result.reason : friendlyError(result.reason, result.code),
      target: parsedTarget,
    })
  }

  const port = await listen(server, host, preferredPort)
  boundPort = port
  config.port = port

  return {
    server,
    port,
    url: `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * undici reports almost every network failure as "fetch failed" and hides the
 * real reason in error.cause.code, so match against both.
 */
function friendlyError(reason, code) {
  const signal = `${code || ''} ${reason || ''}`
  if (/ECONNREFUSED/i.test(signal)) return 'Nothing is listening at this address'
  if (/ENOTFOUND|EAI_AGAIN/i.test(signal)) return 'Host not found'
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ERR_TLS/i.test(signal)) return 'TLS certificate rejected'
  if (/ETIMEDOUT|AbortError|timed out/i.test(signal)) return 'Timed out'
  if (/ECONNRESET/i.test(signal)) return 'Connection reset by the server'
  if (/EHOSTUNREACH|ENETUNREACH/i.test(signal)) return 'Network unreachable'
  if (/redirect/i.test(signal)) return 'Too many redirects'
  return reason || 'Could not reach the server'
}

async function listen(server, host, preferredPort, attempts = 16) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferredPort === 0 ? 0 : preferredPort + offset
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
      return server.address().port
    } catch (error) {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error
    }
  }
  throw new Error(`No free port found between ${preferredPort} and ${preferredPort + attempts - 1}`)
}
