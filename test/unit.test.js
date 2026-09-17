import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUrl, parseArgs } from '../src/cli.js'
import {
  buildProxyPath,
  parseProxyTarget,
  proxyResourceUrl,
  proxyNavigationUrl,
  rewriteHtml,
  rewriteCss,
  rewriteResponseHeaders,
  forwardRequestHeaders,
  splitAuthority,
  decodeBody,
} from '../src/proxy.js'

test('normalizeUrl infers http for local addresses', () => {
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000/')
  assert.equal(normalizeUrl(':5173'), 'http://localhost:5173/')
  assert.equal(normalizeUrl('3000'), 'http://localhost:3000/')
  assert.equal(normalizeUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080/')
  assert.equal(normalizeUrl('192.168.1.20:8000'), 'http://192.168.1.20:8000/')
  assert.equal(normalizeUrl('myapp.test'), 'http://myapp.test/')
})

test('normalizeUrl infers https for public addresses', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/')
  assert.equal(normalizeUrl('github.com/foo/bar'), 'https://github.com/foo/bar')
  assert.equal(normalizeUrl('//example.com/x'), 'https://example.com/x')
})

test('normalizeUrl keeps explicit schemes and rejects nonsense', () => {
  assert.equal(normalizeUrl('http://example.com'), 'http://example.com/')
  assert.equal(normalizeUrl('https://localhost:3000/app'), 'https://localhost:3000/app')
  assert.equal(normalizeUrl(''), '')
  assert.throws(() => normalizeUrl('file:///etc/passwd'))
})

test('parseArgs handles flags, values and positionals', () => {
  assert.deepEqual(parseArgs(['a.com', 'b.com']).urls, ['a.com', 'b.com'])
  assert.equal(parseArgs(['-p', '5000']).port, '5000')
  assert.equal(parseArgs(['--port=5000']).port, '5000')
  assert.equal(parseArgs(['--stacked']).stacked, true)
  assert.equal(parseArgs(['-n']).noOpen, true)
  assert.throws(() => parseArgs(['--nope']))
  assert.throws(() => parseArgs(['--port']))
})

test('parseProxyTarget round-trips through buildProxyPath', () => {
  const original = 'http://localhost:3000/a/b?c=1'
  const path = buildProxyPath(original)
  assert.equal(path, '/p/http/localhost:3000/a/b?c=1')

  const parsed = parseProxyTarget('/p/http/localhost:3000/a/b', '?c=1')
  assert.equal(parsed.target, original)
  assert.equal(parsed.prefix, '/p/http/localhost:3000')
  assert.equal(parsed.isLocal, true)
})

test('parseProxyTarget handles https, bare roots and IPv6', () => {
  assert.equal(parseProxyTarget('/p/https/example.com', '').target, 'https://example.com/')
  assert.equal(parseProxyTarget('/p/https/example.com/x', '').isLocal, false)
  const ipv6 = parseProxyTarget('/p/http/[::1]:3000/x', '')
  assert.equal(ipv6.target, 'http://[::1]:3000/x')
  assert.equal(ipv6.isLocal, true)
})

test('parseProxyTarget rejects anything that is not a proxy path', () => {
  assert.equal(parseProxyTarget('/', ''), null)
  assert.equal(parseProxyTarget('/app.js', ''), null)
  assert.equal(parseProxyTarget('/p/ftp/example.com/x', ''), null)
  assert.equal(parseProxyTarget('/p/http/', ''), null)
  assert.equal(parseProxyTarget('/p/http/evil\r\nX-Leak: 1/x', ''), null)
})

test('splitAuthority copes with IPv6 literals', () => {
  assert.deepEqual(splitAuthority('localhost:3000', 80), { host: 'localhost', port: 3000 })
  assert.deepEqual(splitAuthority('example.com', 443), { host: 'example.com', port: 443 })
  assert.deepEqual(splitAuthority('[::1]:8080', 80), { host: '::1', port: 8080 })
})

test('proxyResourceUrl only rewrites root-relative and same-origin URLs', () => {
  const ctx = { origin: 'http://localhost:3000', prefix: '/p/http/localhost:3000', isLocal: true }

  assert.equal(proxyResourceUrl('/app.js', ctx), '/p/http/localhost:3000/app.js')
  assert.equal(proxyResourceUrl('http://localhost:3000/app.js', ctx), '/p/http/localhost:3000/app.js')
  assert.equal(proxyResourceUrl('http://localhost:3000/app.js?v=2#x', ctx), '/p/http/localhost:3000/app.js?v=2#x')

  // relative URLs already resolve correctly, cross-origin ones load directly
  assert.equal(proxyResourceUrl('./nested.png', ctx), './nested.png')
  assert.equal(proxyResourceUrl('../up.png', ctx), '../up.png')
  assert.equal(proxyResourceUrl('https://cdn.example.com/x.js', ctx), 'https://cdn.example.com/x.js')
  assert.equal(proxyResourceUrl('//cdn.example.com/x.js', ctx), '//cdn.example.com/x.js')
  assert.equal(proxyResourceUrl('data:text/plain,hi', ctx), 'data:text/plain,hi')
  assert.equal(proxyResourceUrl('#anchor', ctx), '#anchor')
  assert.equal(proxyResourceUrl('mailto:a@b.com', ctx), 'mailto:a@b.com')

  // never double-rewrite
  assert.equal(
    proxyResourceUrl('/p/http/localhost:3000/app.js', ctx),
    '/p/http/localhost:3000/app.js'
  )
})

test('proxyNavigationUrl also folds cross-origin hops into the proxy', () => {
  const ctx = { origin: 'http://localhost:3000', prefix: '/p/http/localhost:3000', isLocal: true }
  assert.equal(proxyNavigationUrl('/login', ctx), '/p/http/localhost:3000/login')
  assert.equal(proxyNavigationUrl('https://accounts.example.com/auth', ctx), '/p/https/accounts.example.com/auth')
})

test('rewriteHtml prefixes root-relative URLs, srcset and inline CSS', () => {
  const ctx = { origin: 'https://example.com', prefix: '/p/https/example.com', isLocal: false }
  const html = [
    '<html><head>',
    '<meta http-equiv="Content-Security-Policy" content="frame-ancestors \'none\'">',
    '<link rel="stylesheet" href="/style.css">',
    '<style>body{background:url(/bg.png)}</style>',
    '</head><body>',
    '<a href="/about">about</a>',
    '<img src="/logo.png" srcset="/logo.png 1x, /logo@2x.png 2x">',
    '<img src="https://cdn.example.net/x.png">',
    '<img src="https://example.com/absolute.png">',
    '<a href="mailto:a@b.com">mail</a>',
    '<form action="/submit"></form>',
    '<div style="background:url(\'/hero.jpg\')"></div>',
    '</body></html>',
  ].join('')

  const out = rewriteHtml(html, ctx)

  assert.equal(out.includes('frame-ancestors'), false, 'CSP meta tag is removed')
  assert.ok(out.includes('href="/p/https/example.com/style.css"'))
  assert.ok(out.includes('url(/p/https/example.com/bg.png)'))
  assert.ok(out.includes('href="/p/https/example.com/about"'))
  assert.ok(out.includes('srcset="/p/https/example.com/logo.png 1x, /p/https/example.com/logo@2x.png 2x"'))
  assert.ok(out.includes('src="https://cdn.example.net/x.png"'), 'cross-origin images are untouched')
  assert.ok(out.includes('src="/p/https/example.com/absolute.png"'), 'same-origin absolute is proxied')
  assert.ok(out.includes('action="/p/https/example.com/submit"'))
  assert.ok(out.includes('url(\'/p/https/example.com/hero.jpg\')'))
  assert.ok(out.includes('<a href="mailto:a@b.com">'))
  assert.ok(out.includes('src="/shim.js?p=%2Fp%2Fhttps%2Fexample.com"'))
})

test('rewriteHtml injects the shim even without a head element', () => {
  const ctx = { origin: 'https://example.com', prefix: '/p/https/example.com', isLocal: false }
  const out = rewriteHtml('<body><a href="/x">x</a></body>', ctx)
  assert.ok(out.startsWith('<script src="/shim.js?p='))
  assert.ok(out.includes('<a href="/p/https/example.com/x">x</a>'))
})

test('rewriteCss rewrites url() and @import', () => {
  const ctx = { origin: 'https://example.com', prefix: '/p/https/example.com', isLocal: false }
  const css = '@import "/other.css"; a{background:url(/a.png) no-repeat} b{background:url("/b.png")}'
  const out = rewriteCss(css, ctx)
  assert.ok(out.includes('@import "/p/https/example.com/other.css"'))
  assert.ok(out.includes('url(/p/https/example.com/a.png)'))
  assert.ok(out.includes('url("/p/https/example.com/b.png")'))
})

test('rewriteResponseHeaders strips frame blockers and keeps the site working', () => {
  const ctx = { origin: 'http://localhost:3000', prefix: '/p/http/localhost:3000', isLocal: true }
  const upstream = new Headers()
  upstream.set('x-frame-options', 'DENY')
  upstream.set('content-security-policy', "default-src 'self'; frame-ancestors 'none'; upgrade-insecure-requests")
  upstream.set('cross-origin-opener-policy', 'same-origin')
  upstream.set('strict-transport-security', 'max-age=63072000')
  upstream.set('content-type', 'text/html')
  upstream.append('set-cookie', 'sid=abc; Domain=localhost; Secure; Path=/; SameSite=None')
  upstream.append('set-cookie', 'other=1')

  const out = rewriteResponseHeaders(upstream, ctx)

  assert.equal(out['x-frame-options'], undefined)
  assert.equal(out['cross-origin-opener-policy'], undefined)
  assert.equal(out['strict-transport-security'], undefined)
  assert.equal(out['content-type'], 'text/html')
  assert.equal(out['content-security-policy'], "default-src 'self'")
  assert.deepEqual(out['set-cookie'], [
    'sid=abc; Path=/p/http/localhost:3000/; SameSite=Lax',
    'other=1; Path=/p/http/localhost:3000/',
  ])
})

test('decodeBody honours the declared charset instead of assuming UTF-8', () => {
  const latin1 = Buffer.from('<h1>Caf\xe9 \xd1ino</h1>', 'latin1')

  assert.equal(decodeBody(latin1, 'text/html; charset=iso-8859-1'), '<h1>Café Ñino</h1>')
  assert.equal(decodeBody(Buffer.from('<h1>Café</h1>', 'utf8'), 'text/html'), '<h1>Café</h1>')
  assert.equal(decodeBody(Buffer.from('<h1>Café</h1>', 'utf8'), 'text/html; charset=utf-8'), '<h1>Café</h1>')
  // An unknown label must not throw.
  assert.equal(decodeBody(Buffer.from('hi', 'utf8'), 'text/html; charset=made-up'), 'hi')
})

test('rewriteResponseHeaders drops compression headers for bodies fetch decoded', () => {
  const ctx = { origin: 'http://localhost:3000', prefix: '/p/http/localhost:3000', isLocal: true }
  const upstream = new Headers()
  upstream.set('content-encoding', 'gzip')
  upstream.set('content-length', '481')
  upstream.set('content-type', 'text/html; charset=utf-8')

  const out = rewriteResponseHeaders(upstream, ctx)

  assert.equal(out['content-encoding'], undefined, 'decoded body must not claim to be gzipped')
  assert.equal(out['content-length'], undefined, 'stale compressed length must be dropped')
  assert.equal(out['content-type'], 'text/html; charset=utf-8')
})

test('rewriteResponseHeaders lets the shim through a strict script-src', () => {
  const ctx = { origin: 'https://github.com', prefix: '/p/https/github.com', isLocal: false }
  const upstream = new Headers()
  upstream.set(
    'content-security-policy',
    "default-src 'none'; script-src github.githubassets.com 'sha256-abc='; frame-ancestors 'none'"
  )

  const out = rewriteResponseHeaders(upstream, ctx)

  assert.equal(
    out['content-security-policy'],
    "default-src 'none'; script-src github.githubassets.com 'sha256-abc=' 'self'"
  )
  assert.equal(
    out['content-security-policy'].includes('frame-ancestors'),
    false,
    'frame-ancestors is still stripped'
  )
})

test('rewriteResponseHeaders never invents a script-src', () => {
  const ctx = { origin: 'https://example.com', prefix: '/p/https/example.com', isLocal: false }
  const upstream = new Headers()
  // No script-src here: adding one would override default-src and cut the site
  // off from its own scripts.
  upstream.set('content-security-policy', "default-src 'none'; img-src *")

  const out = rewriteResponseHeaders(upstream, ctx)

  assert.equal(out['content-security-policy'], "default-src 'none'; img-src *")
})

test('rewriteResponseHeaders leaves an existing self alone', () => {
  const ctx = { origin: 'https://example.com', prefix: '/p/https/example.com', isLocal: false }
  const upstream = new Headers()
  upstream.set('content-security-policy', "script-src 'self' https://cdn.example.com")

  const out = rewriteResponseHeaders(upstream, ctx)

  assert.equal(out['content-security-policy'], "script-src 'self' https://cdn.example.com")
})

test('rewriteResponseHeaders forwards an encoding fetch did not decode', () => {
  const ctx = { origin: 'http://localhost:3000', prefix: '/p/http/localhost:3000', isLocal: true }
  const upstream = new Headers()
  upstream.set('content-encoding', 'zstd')
  upstream.set('content-length', '120')

  const out = rewriteResponseHeaders(upstream, ctx)

  assert.equal(out['content-encoding'], 'zstd')
  assert.equal(out['content-length'], '120')
})

test('forwardRequestHeaders rewrites host, origin and referer back to the target', () => {
  const parsed = parseProxyTarget('/p/https/example.com/x', '')
  const out = forwardRequestHeaders(
    {
      host: '127.0.0.1:4747',
      origin: 'http://127.0.0.1:4747',
      referer: 'http://127.0.0.1:4747/p/https/example.com/page',
      cookie: 'sid=abc',
      'accept-encoding': 'gzip, deflate, br, zstd',
      connection: 'keep-alive',
    },
    parsed
  )

  assert.equal(out.host, 'example.com')
  assert.equal(out.origin, 'https://example.com')
  assert.equal(out.referer, 'https://example.com/page')
  assert.equal(out.cookie, 'sid=abc')
  assert.equal(out['accept-encoding'], 'gzip, deflate, br')
  assert.equal(out.connection, undefined)
})
