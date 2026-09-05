#!/usr/bin/env node
import process from 'node:process'

const { runCli } = await import('../dist/index.js')
process.exitCode = await runCli(process.argv.slice(2))
