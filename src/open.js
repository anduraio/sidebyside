import { spawn } from 'node:child_process'

const CANDIDATES =
  process.platform === 'darwin'
    ? [['open', []]]
    : process.platform === 'win32'
      ? [
          ['cmd', ['/c', 'start', '']],
          ['explorer.exe', []],
        ]
      : [
          ['xdg-open', []],
          ['gio', ['open']],
          ['sensible-browser', []],
        ]

function trySpawn(command, args) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

/**
 * Best-effort "open this in the default browser". Resolves false when no
 * launcher worked, so the caller can just print the URL instead.
 */
export async function openBrowser(url) {
  for (const [command, baseArgs] of CANDIDATES) {
    try {
      await trySpawn(command, [...baseArgs, url])
      return true
    } catch {
      /* try the next launcher */
    }
  }
  return false
}
