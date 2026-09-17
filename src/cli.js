import { readFileSync } from 'node:fs'
import { startServer } from './server.js'
import { openBrowser } from './open.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const OPTIONS = {
  '--port': 'port',
  '-p': 'port',
  '--host': 'host',
  '--proxy': 'proxy',
  '-P': 'proxy',
  '--stacked': 'stacked',
  '-s': 'stacked',
  '--no-open': 'noOpen',
  '-n': 'noOpen',
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
  '-v': 'version',
}

const BOOLEAN_OPTIONS = new Set(['proxy', 'stacked', 'noOpen', 'help', 'version'])

const LOCAL_HOST =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|.*\.localhost|.*\.test|.*\.local|.*\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i

export function normalizeUrl(input) {
  let raw = String(input ?? '').trim()
  if (!raw) return ''

  if (/^\d{2,5}$/.test(raw)) raw = `localhost:${raw}`
  if (raw.startsWith(':')) raw = `localhost${raw}`
  if (raw.startsWith('//')) raw = `https:${raw}`

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const authority = raw.split(/[/?#]/)[0]
    const hostname = authority.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    raw = `${LOCAL_HOST.test(hostname) ? 'http' : 'https'}://${raw}`
  }

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Not a valid URL: ${input}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https addresses are supported (got ${url.protocol})`)
  }

  return url.href
}

export function parseArgs(argv) {
  const options = { urls: [] }

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i]

    if (arg === '--') {
      options.urls.push(...argv.slice(i + 1))
      break
    }

    if (!arg.startsWith('-') || arg === '-') {
      options.urls.push(arg)
      continue
    }

    let inlineValue
    const eq = arg.indexOf('=')
    if (eq > 0) {
      inlineValue = arg.slice(eq + 1)
      arg = arg.slice(0, eq)
    }

    const name = OPTIONS[arg]
    if (!name) throw new Error(`Unknown option: ${arg}\n       Run "sbs --help" to see what is available.`)

    if (BOOLEAN_OPTIONS.has(name)) {
      if (inlineValue !== undefined) throw new Error(`${arg} does not take a value`)
      options[name] = true
      continue
    }

    const value = inlineValue !== undefined ? inlineValue : argv[++i]
    if (value === undefined) throw new Error(`${arg} needs a value`)
    options[name] = value
  }

  return options
}

const HELP = `
  sbs — view two sites side by side in one window

  Usage
    $ sbs [url] [url] [options]

  Examples
    $ sbs                              open the viewer, blank panes
    $ sbs :3000 :5173                  two local dev servers
    $ sbs localhost:3000 example.com   a dev server next to a live site
    $ sbs 3000 5173                    bare port numbers work too
    $ sbs --proxy old.test new.test    force proxy mode for both panes

  Options
    -p, --port <port>   port for the viewer            (default: 4747)
        --host <host>   interface to bind              (default: 127.0.0.1)
    -P, --proxy         start both panes in proxy mode
    -s, --stacked       stack the panes vertically instead of side by side
    -n, --no-open       do not open a browser
    -h, --help          show this help
    -v, --version       show the version

  Notes
    Addresses without a scheme default to https, except localhost, loopback
    and private network addresses, which default to http.

    Direct mode embeds the site as-is and is what you want for local dev
    servers. Proxy mode routes the page through this process and strips the
    headers that stop a site from being embedded — use it for sites that
    refuse to load in a frame. Proxy mode can break complex web apps, so each
    pane can switch between the two independently.
`

function color(enabled, code, text) {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text
}

export function formatBanner({ url, panes, port, requestedPort, useColor }) {
  const dim = (text) => color(useColor, '2', text)
  const bold = (text) => color(useColor, '1', text)
  const cyan = (text) => color(useColor, '36', text)

  const lines = ['', `  ${bold('sbs')}  ${dim('·')}  ${cyan(url)}`]
  if (port !== requestedPort) {
    lines.push(`  ${dim(`port ${requestedPort} was busy, using ${port}`)}`)
  }
  lines.push('')

  const labels = ['left ', 'right']
  panes.forEach((pane, index) => {
    const value = pane.url || dim('empty')
    const mode = pane.url ? dim(`(${pane.mode})`) : ''
    lines.push(`  ${dim(labels[index])}  ${value} ${mode}`)
  })

  lines.push('', `  ${dim('ctrl+c to stop')}`, '')
  return lines.join('\n')
}

export async function run(argv) {
  const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR

  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`\n  sbs: ${error.message}\n`)
    process.exitCode = 1
    return
  }

  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return
  }

  if (options.version) {
    process.stdout.write(`${pkg.version}\n`)
    return
  }

  if (options.urls.length > 2) {
    process.stderr.write(
      `\n  sbs: only two panes are supported, ignoring ${options.urls
        .slice(2)
        .map((u) => JSON.stringify(u))
        .join(', ')}\n`
    )
  }

  let urls
  try {
    urls = options.urls.slice(0, 2).map(normalizeUrl)
  } catch (error) {
    process.stderr.write(`\n  sbs: ${error.message}\n`)
    process.exitCode = 1
    return
  }

  const requestedPort = options.port === undefined ? 4747 : Number(options.port)
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    process.stderr.write(`\n  sbs: --port must be a number between 0 and 65535\n`)
    process.exitCode = 1
    return
  }

  const mode = options.proxy ? 'proxy' : 'direct'
  const panes = [
    { url: urls[0] ?? '', mode },
    { url: urls[1] ?? '', mode },
  ]

  const server = await startServer({
    panes,
    orientation: options.stacked ? 'col' : 'row',
    host: options.host || '127.0.0.1',
    preferredPort: requestedPort,
  })

  process.stdout.write(
    `${formatBanner({ url: server.url, panes, port: server.port, requestedPort, useColor })}\n`
  )

  if (!options.noOpen) {
    const opened = await openBrowser(server.url)
    if (!opened) {
      process.stdout.write(`  ${color(useColor, '2', 'could not open a browser automatically — open the URL above')}\n\n`)
    }
  }

  await new Promise((resolve) => {
    const shutdown = () => {
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      resolve()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })

  await server.close()
  process.stdout.write(`\n  ${color(useColor, '2', 'stopped')}\n\n`)
}
