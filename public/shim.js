/**
 * Runs inside every proxied page.
 *
 * The proxy rewrites root-relative URLs in HTML and CSS, but JavaScript builds
 * its own URLs at runtime. This patches the few entry points that matter so
 * `fetch('/api/x')` and friends still resolve to the right place.
 *
 * Everything here is best-effort: if a patch fails we leave the original alone
 * rather than break the page.
 */
;(function () {
  var self = document.currentScript || document.querySelector('script[src^="/shim.js"]')
  if (!self) return

  var prefix = ''
  try {
    prefix = new URL(self.src, window.location.href).searchParams.get('p') || ''
  } catch (error) {
    return
  }
  if (!prefix) return

  function fix(value) {
    if (typeof value !== 'string' || value.charAt(0) !== '/') return value
    if (value.charAt(1) === '/') return value
    if (value === prefix || value.indexOf(prefix + '/') === 0) return value
    return prefix + value
  }

  var nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') {
          input = fix(input)
        } else if (input instanceof Request) {
          var fixed = fix(input.url)
          if (fixed !== input.url) input = new Request(fixed, input)
        } else if (input && typeof input === 'object' && typeof input.url === 'string') {
          var href = fix(input.url)
          if (href !== input.url) input = new Request(href, input)
        }
      } catch (error) {
        /* fall through with the original arguments */
      }
      return nativeFetch.call(this, input, init)
    }
  }

  var nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments)
    try {
      args[1] = fix(args[1])
    } catch (error) {
      /* ignore */
    }
    return nativeOpen.apply(this, args)
  }

  var nativeSendBeacon = navigator.sendBeacon
  if (typeof nativeSendBeacon === 'function') {
    navigator.sendBeacon = function (url, data) {
      try {
        url = fix(url)
      } catch (error) {
        /* ignore */
      }
      return nativeSendBeacon.call(navigator, url, data)
    }
  }

  var history = window.history
  if (history && typeof history.pushState === 'function') {
    var patchState = function (name) {
      var native = history[name]
      history[name] = function (state, title, url) {
        if (url !== undefined && url !== null) {
          try {
            url = fix(String(url))
          } catch (error) {
            /* ignore */
          }
        }
        return native.call(history, state, title, url)
      }
    }
    patchState('pushState')
    patchState('replaceState')
  }
})()
