#!/usr/bin/env node
import process from 'node:process'

const { runMcpServer } = await import('../dist/index.js')
process.exitCode = await runMcpServer(process.argv.slice(2))
