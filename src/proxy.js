import net from 'node:net'
import tls from 'node:tls'
import { Readable } from 'node:stream'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const DROP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'alt-svc',
  'report-to',
  'nel',
  'expect-ct',
])

const AUTHORITY_RE = /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i

export const PROXY_BASE = '/p/'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/**
 * Turn a real URL into a path on this server.
 * https://localhost:3000/a/b?c  ->  /p/https/localhost:3000/a/b?c
 */
export function buildProxyPath(url) {
  const u = url instanceof URL ? url : new URL(url)
  const scheme = u.protocol.slice(0, -1)
  return `${PROXY_BASE}${scheme}/${u.host}${u.pathname}${u.search}${u.hash}`
}

/**
 * Reverse of buildProxyPath. Returns null when the path is not a proxy path.
 */
export function parseProxyTarget(pathname, search = '') {
  if (!pathname.startsWith(PROXY_BASE)) return null

  const rest = pathname.slice(PROXY_BASE.length)
  const schemeEnd = rest.indexOf('/')
  if (schemeEnd < 0) return null

  const scheme = rest.slice(0, schemeEnd).toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') return null

  const afterScheme = rest.slice(schemeEnd + 1)
  const authorityEnd = afterScheme.indexOf('/')
  const authority = authorityEnd < 0 ? afterScheme : afterScheme.slice(0, authorityEnd)
  const tail = authorityEnd < 0 ? '/' : afterScheme.slice(authorityEnd)

  if (!AUTHORITY_RE.test(authority)) return null

  const query = search && search[0] === '?' ? search : ''
  const prefix = `${PROXY_BASE}${scheme}/${authority}`
  const origin = `${scheme}://${authority}`
  const target = `${origin}${tail}${query}`

  return { scheme, authority, prefix, origin, path: tail, query, target, isLocal: isLocalAuthority(authority) }
}

/** Split "host:port" (or "[::1]:port") without choking on IPv6 colons. */
export function splitAuthority(authority, fallbackPort) {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(authority)
  const host = match ? match[1].replace(/^\[|\]$/g, '') : authority
  const port = Number(match && match[2]) || fallbackPort
  return { host, port }
}

function isLocalAuthority(authority) {
  const host = splitAuthority(authority, 80).host.toLowerCase()
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
}

export function makeContext(parsed) {
  return { origin: parsed.origin, prefix: parsed.prefix, isLocal: parsed.isLocal }
}

/* ------------------------------------------------------------------ *
 * URL rewriting
 * ------------------------------------------------------------------ */

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i
const HTTP_SCHEME_RE = /^https?:/i
const REWRITABLE_ATTR =
  /\b(href|src|action|poster|formaction|data-src|data-href|manifest|ping|background)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
const SRCSET_ATTR = /\b(srcset|imagesrcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
const STYLE_ATTR = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
const CSP_META = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi
const REFRESH_META = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi

/**
 * Work out what kind of URL reference we are looking at, without guessing.
 * `http://x` is absolute; `foo:bar` (mailto, data, javascript...) is not ours.
 */
function classify(raw) {
  if (raw[0] === '#') return 'fragment'
  if (raw.startsWith('//')) return 'protocol-relative'
  if (raw[0] === '/') return 'root-relative'
  if (SCHEME_RE.test(raw)) return HTTP_SCHEME_RE.test(raw) ? 'absolute' : 'foreign-scheme'
  return 'relative'
}

function sameOrigin(absolute, ctx) {
  try {
    const u = new URL(absolute)
    return `${u.protocol}//${u.host}` === ctx.origin
  } catch {
    return false
  }
}

function sameHost(absolute, ctx) {
  try {
    return new URL(absolute).host === new URL(ctx.origin).host
  } catch {
    return false
  }
}

/**
 * Rewrite a URL found in a resource (html attribute, css url()) so it keeps
 * being served through this proxy. Cross-origin URLs are left alone: they load
 * directly from their real host, which is fine for sub-resources.
 */
export function proxyResourceUrl(value, ctx) {
  if (typeof value !== 'string') return value
  const raw = value.trim()
  if (!raw) return value

  const kind = classify(raw)
  if (kind === 'fragment' || kind === 'foreign-scheme' || kind === 'relative') return value

  // Relative URLs already resolve against /p/<scheme>/<host>/<path>, so the
  // only thing that breaks is a root-relative path.
  if (kind === 'root-relative') {
    if (raw === ctx.prefix || raw.startsWith(ctx.prefix + '/')) return value
    return ctx.prefix + raw
  }

  if (kind === 'protocol-relative') {
    if (!sameHost(`https:${raw}`, ctx)) return value
    const u = new URL(`https:${raw}`)
    return ctx.prefix + u.pathname + u.search + u.hash
  }

  if (!sameOrigin(raw, ctx)) return value
  const u = new URL(raw)
  return ctx.prefix + u.pathname + u.search + u.hash
}

/**
 * Rewrite a URL used for navigation (redirects). Unlike resources, a
 * cross-origin hop is also proxied so the pane never escapes the viewer.
 */
export function proxyNavigationUrl(value, ctx) {
  if (typeof value !== 'string') return value
  const raw = value.trim()
  if (!raw) return value

  const kind = classify(raw)
  if (kind === 'fragment' || kind === 'foreign-scheme' || kind === 'relative') return value

  if (kind === 'root-relative') {
    if (raw === ctx.prefix || raw.startsWith(ctx.prefix + '/')) return value
    return ctx.prefix + raw
  }

  const absolute = kind === 'protocol-relative' ? `https:${raw}` : raw
  try {
    const u = new URL(absolute)
    if (sameOrigin(absolute, ctx)) return ctx.prefix + u.pathname + u.search + u.hash
    return buildProxyPath(u)
  } catch {
    return value
  }
}

/** Turn a proxied URL (as seen by the site's own JS) back into the real one. */
export function unproxyUrl(value) {
  try {
    const u = new URL(value)
    const parsed = parseProxyTarget(u.pathname, '')
    if (!parsed) return null
    return `${parsed.origin}${parsed.path}${u.search}`
  } catch {
    return null
  }
}

export function rewriteCss(css, ctx) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
      const rewritten = proxyResourceUrl(url, ctx)
      return rewritten === url ? match : `url(${quote}${rewritten}${quote})`
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, url) => {
      const rewritten = proxyResourceUrl(url, ctx)
      return rewritten === url ? match : `@import ${quote}${rewritten}${quote}`
    })
}

export function rewriteHtml(html, ctx) {
  let out = html

  out = out.replace(CSP_META, '')
  out = out.replace(REFRESH_META, (tag) =>
    tag.replace(/(content\s*=\s*)(["'])([^"']*)\2/i, (match, head, quote, content) => {
      const rewritten = content.replace(/url\s*=\s*([^;]+)/i, (inner, target) => {
        return `url=${proxyNavigationUrl(target.trim(), ctx)}`
      })
      return `${head}${quote}${rewritten}${quote}`
    })
  )

  out = out.replace(REWRITABLE_ATTR, (match, attr, whole, dq, sq, bare) => {
    const value = dq ?? sq ?? bare
    const rewritten = proxyResourceUrl(value, ctx)
    if (rewritten === value) return match
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : ''
    return `${attr}=${quote}${rewritten}${quote}`
  })

  out = out.replace(SRCSET_ATTR, (match, attr, whole, dq, sq, bare) => {
    const value = dq ?? sq ?? bare
    if (value.includes('data:')) return match
    const rewritten = value
      .split(',')
      .map((part) => {
        const trimmed = part.trim()
        if (!trimmed) return trimmed
        const [url, ...descriptors] = trimmed.split(/\s+/)
        return [proxyResourceUrl(url, ctx), ...descriptors].join(' ')
      })
      .join(', ')
    if (rewritten === value) return match
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : ''
    return `${attr}=${quote}${rewritten}${quote}`
  })

  out = out.replace(STYLE_BLOCK, (match, css) => `<style>${rewriteCss(css, ctx)}</style>`)
  out = out.replace(STYLE_ATTR, (match, whole, dq, sq) => {
    const value = dq ?? sq ?? ''
    const rewritten = rewriteCss(value, ctx)
    if (rewritten === value) return match
    const quote = dq !== undefined ? '"' : "'"
    return `style=${quote}${rewritten}${quote}`
  })

  return injectShim(out, ctx)
}

function injectShim(html, ctx) {
  // The prefix travels in the script URL rather than an inline script: a strict
  // script-src blocks inline scripts outright, which would silently disable the
  // shim on exactly the sites that need it most.
  const tag = `<script src="/shim.js?p=${encodeURIComponent(ctx.prefix)}"></script>`
  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  const root = /<html[^>]*>/i.exec(html)
  if (root) {
    const at = root.index + root[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  return tag + html
}

/* ------------------------------------------------------------------ *
 * Header rewriting
 * ------------------------------------------------------------------ */

function stripCsp(value, ctx) {
  const directives = value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((directive) => {
      const name = directive.split(/\s+/)[0].toLowerCase()
      if (name === 'frame-ancestors' || name === 'sandbox') return false
      // A local http target served over the proxy must not force https upgrades.
      if (ctx.isLocal && name === 'upgrade-insecure-requests') return false
      return true
    })
    .map((directive) => {
      const [name, ...sources] = directive.split(/\s+/)
      if (name.toLowerCase() !== 'script-src') return directive
      if (sources.includes("'self'")) return directive
      // '/shim.js' is same-origin with the proxied document, so without 'self'
      // a site whose policy omits it would block our shim. Only ever appended to
      // a script-src that already exists — inventing one would override
      // default-src and strip the site's own scripts.
      return `${name} ${sources.join(' ')} 'self'`.replace(/\s+/g, ' ').trim()
    })
  return directives.join('; ')
}

function rewriteSetCookie(value, ctx) {
  let out = value
    .replace(/;\s*Domain=[^;]*/gi, '')
    .replace(/;\s*Secure/gi, '')
    .replace(/;\s*Partitioned/gi, '')
    .replace(/;\s*SameSite=None/gi, '; SameSite=Lax')

  if (/;\s*Path=/i.test(out)) {
    out = out.replace(/;\s*Path=([^;]*)/i, (match, p) => {
      const path = p.trim()
      return `; Path=${ctx.prefix}${path.startsWith('/') ? path : '/'}`
    })
  } else {
    out += `; Path=${ctx.prefix}/`
  }

  return out
}

export function forwardRequestHeaders(headers, parsed) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase()
    if (HOP_BY_HOP.has(name)) continue
    if (name === 'host' || name === 'content-length' || name === 'accept-encoding') continue
    out[name] = value
  }

  out.host = parsed.authority
  out['accept-encoding'] = 'gzip, deflate, br'
  out['user-agent'] = headers['user-agent'] || UA

  // The browser sends our own origin here because that is where the page was
  // served from. Sites check these for CSRF, so they have to look like they
  // came from the target itself.
  if (out.origin) {
    out.origin = unproxyUrl(out.origin) || parsed.origin
  }
  if (out.referer) {
    const real = unproxyUrl(out.referer)
    if (real) out.referer = real
    else delete out.referer
  }

  return out
}

/**
 * Undici decodes these for us. It leaves the original content-encoding and
 * content-length headers in place though, which then describe the decoded body
 * incorrectly — so anything it decoded has to be dropped before we forward it.
 * Anything outside this list arrives still compressed and is passed through.
 */
const DECODED_ENCODINGS = /^(?:gzip|x-gzip|deflate|br)$/i

export function isDecodedByFetch(encoding) {
  return !encoding || DECODED_ENCODINGS.test(encoding.trim())
}

const CHARSET_RE = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i

/**
 * Decode a response body using the charset it declares.
 *
 * response.text() cannot be used here: it ignores the charset parameter and
 * always decodes as UTF-8, which silently corrupts every non-UTF-8 page before
 * we ever get to rewrite it.
 */
export function decodeBody(bytes, contentType) {
  const match = CHARSET_RE.exec(contentType || '')
  const label = match ? match[1] : 'utf-8'
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    // Unknown or unsupported label — fall back to UTF-8.
    return new TextDecoder('utf-8').decode(bytes)
  }
}

export function rewriteResponseHeaders(headers, ctx) {
  const out = {}
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const decoded = isDecodedByFetch(headers.get('content-encoding'))

  for (const [key, value] of headers) {
    const name = key.toLowerCase()
    if (HOP_BY_HOP.has(name)) continue
    if (DROP_RESPONSE_HEADERS.has(name)) continue
    if (name === 'set-cookie') continue
    if (decoded && (name === 'content-encoding' || name === 'content-length')) continue

    if (name === 'content-security-policy') {
      const kept = stripCsp(value, ctx)
      if (kept) out[name] = kept
      continue
    }
    if (name === 'location') {
      out[name] = proxyNavigationUrl(value, ctx)
      continue
    }
    out[name] = value
  }

  if (cookies.length) {
    out['set-cookie'] = cookies.map((cookie) => rewriteSetCookie(cookie, ctx))
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Request handling
 * ------------------------------------------------------------------ */

const REWRITABLE_TYPE = /(?:text\/html|application\/xhtml\+xml)/i
const CSS_TYPE = /text\/css/i
const MAX_REQUEST_BODY = 16 * 1024 * 1024

async function readRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_REQUEST_BODY) throw new Error('Request body too large')
    chunks.push(chunk)
  }
  return chunks.length ? Buffer.concat(chunks) : undefined
}

export async function proxyRequest(req, res, parsed) {
  const ctx = makeContext(parsed)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)

  let upstream
  try {
    const body = await readRequestBody(req)
    upstream = await fetch(parsed.target, {
      method: req.method,
      headers: forwardRequestHeaders(req.headers, parsed),
      body,
      redirect: 'manual',
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' })
    res.end(errorPage(parsed.target, error))
    return
  }
  clearTimeout(timer)

  const headers = rewriteResponseHeaders(upstream.headers, ctx)
  const type = upstream.headers.get('content-type') || ''
  const isHtml = REWRITABLE_TYPE.test(type)
  const isCss = CSS_TYPE.test(type)
  const noBody = req.method === 'HEAD' || upstream.status === 204 || upstream.status === 304

  if (noBody) {
    res.writeHead(upstream.status, headers)
    res.end()
    return
  }

  if ((isHtml || isCss) && isDecodedByFetch(upstream.headers.get('content-encoding'))) {
    const bytes = Buffer.from(await upstream.arrayBuffer())
    const raw = decodeBody(bytes, type)
    const rewritten = isHtml ? rewriteHtml(raw, ctx) : rewriteCss(raw, ctx)
    // The body has been decoded and re-encoded as UTF-8, so the declared
    // charset has to describe the bytes we are actually sending.
    const mediaType = (type || (isHtml ? 'text/html' : 'text/css')).split(';')[0].trim()
    headers['content-type'] = `${mediaType}; charset=utf-8`
    const buffer = Buffer.from(rewritten, 'utf8')
    headers['content-length'] = String(buffer.length)
    res.writeHead(upstream.status, headers)
    res.end(buffer)
    return
  }

  res.writeHead(upstream.status, headers)
  if (!upstream.body) {
    res.end()
    return
  }
  const stream = Readable.fromWeb(upstream.body)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/* ------------------------------------------------------------------ *
 * WebSocket / upgrade passthrough (keeps HMR working through the proxy)
 * ------------------------------------------------------------------ */

export function proxyUpgrade(req, socket, head, parsed) {
  let settled = false
  const fail = (status = 502) => {
    if (settled) return
    settled = true
    try {
      socket.write(`HTTP/1.1 ${status} Bad Gateway\r\nConnection: close\r\n\r\n`)
    } catch {
      /* socket already gone */
    }
    socket.destroy()
  }

  const isTls = parsed.scheme === 'https'
  const { host, port } = splitAuthority(parsed.authority, isTls ? 443 : 80)

  const upstream = isTls
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port })

  upstream.setTimeout(20_000, () => fail(504))
  upstream.on('error', () => fail())
  upstream.on('close', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())

  upstream.on(isTls ? 'secureConnect' : 'connect', () => {
    if (settled) return
    settled = true
    upstream.setTimeout(0)

    const headers = forwardRequestHeaders(req.headers, parsed)
    let raw = `${req.method} ${parsed.path}${parsed.query} HTTP/1.1\r\n`
    for (const [key, value] of Object.entries(headers)) {
      raw += `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`
    }
    raw += '\r\n'

    upstream.write(raw)
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
}

/* ------------------------------------------------------------------ *
 * Frameability probe
 * ------------------------------------------------------------------ */

export async function probeFrameable(target) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*' },
    })
    const xfo = res.headers.get('x-frame-options')
    const csp = res.headers.get('content-security-policy') || ''
    const blocks = /frame-ancestors/i.test(csp)
    await res.body?.cancel().catch(() => {})
    return {
      ok: true,
      status: res.status,
      finalUrl: res.url,
      frameable: !xfo && !blocks,
      reason: xfo ? `X-Frame-Options: ${xfo}` : blocks ? 'Content-Security-Policy: frame-ancestors' : null,
    }
  } catch (error) {
    return {
      ok: false,
      frameable: true,
      code: error?.cause?.code || error?.code || error?.name || null,
      reason: error?.name === 'AbortError' ? 'Timed out' : error?.message || 'Unreachable',
    }
  } finally {
    clearTimeout(timer)
  }
}

function errorPage(target, error) {
  const message = error?.name === 'AbortError' ? 'The upstream server timed out.' : error?.message || 'Unknown error'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;display:grid;place-items:center;background:#0b0d10;color:#e6e9ef;
      font:14px/1.6 ui-sans-serif,-apple-system,"Segoe UI",sans-serif}
    div{max-width:34rem;padding:2rem}
    h1{margin:0 0 .5rem;font-size:1rem;font-weight:600;color:#ff8080}
    p{margin:.25rem 0;color:#8b95a5}
    code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#e6e9ef;
      background:#151a1f;padding:.15rem .35rem;border-radius:4px;word-break:break-all}
  </style></head><body><div>
    <h1>Could not reach this site through the proxy</h1>
    <p><code>${escapeHtml(target)}</code></p>
    <p>${escapeHtml(message)}</p>
    <p>Check that the server is running, or switch this pane to Direct mode.</p>
  </div></body></html>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}
