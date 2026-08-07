#!/usr/bin/env node

import readline from 'node:readline'
import process from 'node:process'

import { createBaimiaoServer } from './baimiao-server.mjs'
import { createJsonRpcLineHandler } from './json-rpc.mjs'

const server = await createBaimiaoServer()
const handleLine = createJsonRpcLineHandler(server.handleRequest)
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

for await (const line of input) {
  if (!line.trim()) continue
  const response = await handleLine(line)
  if (response) process.stdout.write(`${response}\n`)
}
