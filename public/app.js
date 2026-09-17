const STORAGE_KEY = 'sbs.v1'

const config = window.__SBS__ || {}

const stage = document.getElementById('stage')
const divider = document.getElementById('divider')
const toastHost = document.getElementById('toasts')
const barsButton = document.getElementById('toggle-bars')

const panes = [...document.querySelectorAll('.pane')].map((el) => ({
  el,
  input: el.querySelector('.url-input'),
  frame: el.querySelector('.frame'),
  wrap: el.querySelector('.frame-wrap'),
  errorTitle: el.querySelector('.error-title'),
  errorDetail: el.querySelector('.error-detail'),
}))

const LOCAL_HOST =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|.*\.localhost|.*\.test|.*\.local|.*\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i

const FATAL_PROBE_CODES =
  /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNRESET|CERT_|DEPTH_ZERO|ERR_TLS|UNABLE_TO_VERIFY|SELF_SIGNED)/

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/* ------------------------------------------------------------------ state */

function defaultPane(source, index) {
  const url = source?.url || ''
  return {
    url,
    mode: source?.mode === 'proxy' ? 'proxy' : 'direct',
    auto: true,
    notice: null,
    loading: false,
  }
}

function loadState() {
  const fromCli = (config.panes || []).some((pane) => pane?.url)
  const base = {
    panes: [defaultPane(config.panes?.[0], 0), defaultPane(config.panes?.[1], 1)],
    orientation: config.orientation === 'col' ? 'col' : 'row',
    split: 50,
    fullscreen: null,
    bars: true,
  }

  if (fromCli) return base

  let saved = null
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
  } catch {
    saved = null
  }
  if (!saved) return base

  return {
    panes: [0, 1].map((i) => {
      const pane = defaultPane(saved.panes?.[i], i)
      pane.auto = saved.panes?.[i]?.auto !== false
      return pane
    }),
    orientation: saved.orientation === 'col' ? 'col' : 'row',
    split: clamp(Number(saved.split) || 50, 12, 88),
    fullscreen: saved.fullscreen === 0 || saved.fullscreen === 1 ? saved.fullscreen : null,
    bars: saved.bars !== false,
  }
}

const state = loadState()

function save() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        panes: state.panes.map(({ url, mode, auto }) => ({ url, mode, auto })),
        orientation: state.orientation,
        split: state.split,
        fullscreen: state.fullscreen,
        bars: state.bars,
      })
    )
  } catch {
    /* storage unavailable — the viewer still works */
  }
}

/* -------------------------------------------------------------- addresses */

function normalizeUrl(input) {
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
    throw new Error(`not a valid address: ${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http and https addresses work here`)
  }
  return url.href
}

function proxyPath(url) {
  const parsed = new URL(url)
  return `/p/${parsed.protocol.slice(0, -1)}/${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`
}

function hostLabel(url) {
  try {
    const parsed = new URL(url)
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname)
  } catch {
    return url
  }
}

function frameSrc(pane) {
  if (!pane.url) return null
  return pane.mode === 'proxy' ? proxyPath(pane.url) : pane.url
}

/* ----------------------------------------------------------------- render */

function render() {
  const root = document.documentElement
  root.dataset.orientation = state.orientation
  root.dataset.fullscreen = state.fullscreen === null ? '' : String(state.fullscreen)
  root.dataset.bars = state.bars ? 'shown' : 'hidden'
  stage.style.setProperty('--split', `${state.split}%`)

  barsButton.title = `${state.bars ? 'Hide' : 'Show'} the pane toolbars — Alt+B`

  document.querySelectorAll('[data-layout]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.layout === state.orientation)
  })

  state.panes.forEach((pane, index) => renderPane(pane, index))
  save()
}

function paneStatus(pane) {
  if (pane.notice?.kind === 'error') return 'error'
  if (!pane.url) return 'empty'
  return pane.loading ? 'loading' : 'ready'
}

function renderPane(pane, index) {
  const view = panes[index]

  if (document.activeElement !== view.input && view.input.value !== pane.url) {
    view.input.value = pane.url
  }

  view.el.dataset.mode = pane.mode
  view.el.dataset.focused = String(state.fullscreen === null ? state.lastFocused === index : state.fullscreen === index)
  view.el.querySelectorAll('[data-mode]').forEach((button) => {
    const active = button.dataset.mode === pane.mode
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-pressed', String(active))
  })

  const src = frameSrc(pane)
  const key = src || ''

  if (view.frame.dataset.key !== key) {
    view.frame.dataset.key = key
    pane.loading = Boolean(src)
    view.frame.src = src || 'about:blank'
  }

  const status = paneStatus(pane)
  view.el.dataset.status = status

  if (status === 'error') {
    view.errorTitle.textContent = pane.notice.title
    view.errorDetail.innerHTML = ''
    const code = document.createElement('code')
    code.textContent = pane.notice.detail
    view.errorDetail.append(code)
    if (pane.notice.hint) {
      view.errorDetail.append(document.createElement('br'), document.createTextNode(pane.notice.hint))
    }
  }
}

/* ------------------------------------------------------------------ probe */

async function probe(index) {
  const pane = state.panes[index]
  if (!pane.url) return
  const url = pane.url
  const mode = pane.mode

  let data
  try {
    const response = await fetch(`/api/probe?url=${encodeURIComponent(url)}`)
    data = await response.json()
  } catch {
    return
  }

  if (state.panes[index].url !== url) return

  if (!data.ok) {
    const fatal = FATAL_PROBE_CODES.test(String(data.code || ''))
    if (fatal) {
      state.panes[index].notice = {
        kind: 'error',
        title: data.reason,
        detail: url,
        hint: LOCAL_HOST.test(new URL(url).hostname)
          ? 'Is the dev server running on that port?'
          : 'Check the address or your network connection.',
      }
      render()
    } else {
      toast(`${hostLabel(url)} — ${data.reason}`, 'warn')
    }
    return
  }

  if (state.panes[index].notice?.kind === 'error') {
    state.panes[index].notice = null
    render()
  }

  if (!data.frameable && mode === 'direct' && state.panes[index].auto) {
    state.panes[index].mode = 'proxy'
    render()
    toast(`${hostLabel(url)} blocks embedding (${data.reason}) — switched to Proxy`, 'warn', {
      label: 'Undo',
      run: () => {
        state.panes[index].auto = false
        state.panes[index].mode = 'direct'
        render()
      },
    })
  }
}

/* --------------------------------------------------------------- commands */

function applyUrl(index, url) {
  const pane = state.panes[index]
  pane.url = url
  pane.notice = null
  pane.auto = true
  render()
  if (url) probe(index)
}

/** Resolve what the user typed, or report why we cannot. */
function resolveInput(index, raw) {
  try {
    return normalizeUrl(raw)
  } catch (error) {
    toast(error.message, 'error')
    panes[index].input.value = state.panes[index].url
    return null
  }
}

function submit(index) {
  const view = panes[index]
  const url = resolveInput(index, view.input.value)
  if (url === null) return

  // Sync the input before blurring so the blur handler below sees no pending
  // change and does not fire a second, conflicting navigation.
  view.input.value = url
  view.input.blur()

  if (url === state.panes[index].url) reload(index)
  else applyUrl(index, url)
}

function setMode(index, mode) {
  const pane = state.panes[index]
  if (pane.mode === mode) return
  pane.mode = mode
  pane.auto = false
  pane.notice = null
  render()
  if (pane.url) probe(index)
}

/**
 * Re-navigate the pane to the address in the URL bar.
 *
 * This deliberately re-assigns src instead of calling location.reload(): a
 * proxied pane is same-origin with the viewer, so reload() would succeed and
 * reload whatever document happens to be committed — including one from a
 * navigation that has not finished yet, cancelling it.
 */
function reload(index) {
  const view = panes[index]
  const pane = state.panes[index]
  pane.notice = null

  if (!pane.url) {
    render()
    return
  }

  view.frame.dataset.key = ''
  render()
}

function reloadAll() {
  state.panes.forEach((_, index) => reload(index))
}

function swap() {
  const [a, b] = state.panes
  for (const key of ['url', 'mode', 'auto', 'notice', 'loading']) {
    const held = a[key]
    a[key] = b[key]
    b[key] = held
  }
  panes.forEach((view) => {
    view.frame.dataset.key = ''
  })
  render()
  state.panes.forEach((pane, index) => {
    if (pane.url) probe(index)
  })
}

function toggleFullscreen(index) {
  state.fullscreen = state.fullscreen === index ? null : index
  render()
}

function toggleBars() {
  state.bars = !state.bars
  render()
}

function applySplit(clientX, clientY) {
  const rect = stage.getBoundingClientRect()
  const ratio =
    state.orientation === 'row'
      ? (clientX - rect.left) / rect.width
      : (clientY - rect.top) / rect.height
  state.split = clamp(ratio * 100, 12, 88)
  stage.style.setProperty('--split', `${state.split}%`)
}

/* --------------------------------------------------------------- toasts */

function toast(message, kind = 'info', action = null) {
  const el = document.createElement('div')
  el.className = `toast toast-${kind}`

  const text = document.createElement('span')
  text.textContent = message
  el.append(text)

  const dismiss = () => {
    clearTimeout(timer)
    el.remove()
  }

  if (action) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'toast-action'
    button.textContent = action.label
    button.addEventListener('click', () => {
      action.run()
      dismiss()
    })
    el.append(button)
  }

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'toast-close'
  close.title = 'Dismiss'
  close.innerHTML = '<svg class="i"><use href="#i-close"></use></svg>'
  close.addEventListener('click', dismiss)
  el.append(close)

  toastHost.append(el)
  const timer = setTimeout(dismiss, action ? 9000 : 5000)
}

/* ----------------------------------------------------------------- events */

panes.forEach((view, index) => {
  view.el.addEventListener('pointerdown', () => {
    state.lastFocused = index
    document.querySelectorAll('.pane').forEach((el, i) => {
      el.dataset.focused = String(state.fullscreen === null && i === index)
    })
  })

  view.el.querySelector('.url-form').addEventListener('submit', (event) => {
    event.preventDefault()
    submit(index)
  })

  view.input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      view.input.value = state.panes[index].url
      view.input.blur()
    }
  })

  view.input.addEventListener('blur', () => {
    const current = state.panes[index].url
    if (view.input.value === current) return

    const url = resolveInput(index, view.input.value)
    if (url === null) return
    if (url === current) {
      view.input.value = url
      return
    }
    applyUrl(index, url)
  })

  view.frame.addEventListener('load', () => {
    const pane = state.panes[index]
    pane.loading = false
    // The browser also fires load for blocked frames and for our own 502 page,
    // so recompute rather than assuming the pane is fine now.
    view.el.dataset.status = paneStatus(pane)
  })

  view.el.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.act
      if (action === 'reload') reload(index)
      if (action === 'retry') {
        state.panes[index].notice = null
        reload(index)
        probe(index)
      }
      if (
        action === 'external' &&
        state.panes[index].url &&
        window.open(state.panes[index].url, '_blank', 'noopener')
      ) {
        /* opened */
      }
      if (action === 'full') toggleFullscreen(index)
    })
  })

  view.el.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => setMode(index, button.dataset.mode))
  })

  view.el.querySelectorAll('[data-fill]').forEach((button) => {
    button.addEventListener('click', () => {
      view.input.value = button.dataset.fill
      submit(index)
    })
  })
})

document.querySelectorAll('[data-layout]').forEach((button) => {
  button.addEventListener('click', () => {
    state.orientation = button.dataset.layout === 'col' ? 'col' : 'row'
    render()
  })
})

document.getElementById('swap').addEventListener('click', swap)
document.getElementById('reload-all').addEventListener('click', reloadAll)
barsButton.addEventListener('click', toggleBars)

divider.addEventListener('pointerdown', (event) => {
  divider.setPointerCapture(event.pointerId)
  divider.dataset.dragging = 'true'
  document.body.dataset.dragging = 'true'
  applySplit(event.clientX, event.clientY)
})

divider.addEventListener('pointermove', (event) => {
  if (divider.dataset.dragging !== 'true') return
  applySplit(event.clientX, event.clientY)
})

const endDrag = (event) => {
  if (divider.dataset.dragging !== 'true') return
  delete divider.dataset.dragging
  delete document.body.dataset.dragging
  if (event.pointerId !== undefined && divider.hasPointerCapture(event.pointerId)) {
    divider.releasePointerCapture(event.pointerId)
  }
  save()
}

divider.addEventListener('pointerup', endDrag)
divider.addEventListener('pointercancel', endDrag)

divider.addEventListener('dblclick', () => {
  state.split = 50
  render()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.fullscreen !== null) {
    toggleFullscreen(state.fullscreen)
    return
  }

  if (!event.altKey || event.metaKey || event.ctrlKey) return

  const index = state.lastFocused ?? 0
  const key = event.key.toLowerCase()

  if (key === 'r') {
    event.preventDefault()
    reloadAll()
  } else if (key === 's') {
    event.preventDefault()
    swap()
  } else if (key === 'm') {
    event.preventDefault()
    setMode(index, state.panes[index].mode === 'proxy' ? 'direct' : 'proxy')
  } else if (key === 'f') {
    event.preventDefault()
    toggleFullscreen(index)
  } else if (key === 'b') {
    event.preventDefault()
    toggleBars()
  } else if (key === '1' || key === '2') {
    event.preventDefault()
    const target = Number(key) - 1
    state.lastFocused = target
    panes[target].input.focus()
    panes[target].input.select()
  }
})

/* ------------------------------------------------------------------- boot */

state.lastFocused = 0
render()

if (state.panes.every((pane) => !pane.url)) {
  panes[0].input.focus()
} else {
  state.panes.forEach((pane, index) => {
    if (pane.url) probe(index)
  })
}
