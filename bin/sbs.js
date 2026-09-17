#!/usr/bin/env node
import { run } from '../src/cli.js'

run(process.argv.slice(2)).catch((error) => {
  const message = error && error.message ? error.message : String(error)
  process.stderr.write(`\n  sbs: ${message}\n\n`)
  process.exit(1)
})
