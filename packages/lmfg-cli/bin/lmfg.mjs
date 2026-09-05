#!/usr/bin/env node
import process from 'node:process'

const { runCli } = await import('../dist/cli.js')
process.exitCode = await runCli(process.argv.slice(2))
