import assert from 'node:assert/strict'
import * as nodeFileSystem from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { createLocalArtifactTransactions } from '../skills/baimiao-local-media/scripts/local-artifact-transaction.mjs'

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'baimiao-artifact-test-'))

try {
  const transactions = createLocalArtifactTransactions()
  const planPath = path.join(temporaryRoot, 'array-plan.json')
  await writeFile(planPath, '[]', 'utf8')

  await assert.rejects(
    transactions.readJsonPlan(planPath),
    (error) => error?.code === 'INVALID_PLAN',
  )

  const maximumPlanPath = path.join(temporaryRoot, 'maximum-plan.json')
  const prefix = '{"value":"'
  const suffix = '"}'
  const maximumPlan = `${prefix}${'a'.repeat(1024 * 1024 - prefix.length - suffix.length)}${suffix}`
  await writeFile(maximumPlanPath, maximumPlan, 'utf8')
  assert.equal(
    (await transactions.readJsonPlan(maximumPlanPath)).value.length,
    1024 * 1024 - prefix.length - suffix.length,
  )

  const existingOutput = path.join(temporaryRoot, 'existing.pdf')
  await writeFile(existingOutput, 'preserve me', 'utf8')
  await assert.rejects(
    transactions.resolveOutputPath(existingOutput),
    (error) => error?.code === 'OUTPUT_EXISTS',
  )

  const inputPath = path.join(temporaryRoot, 'input.pdf')
  const committedOutput = path.join(temporaryRoot, 'committed.pdf')
  await writeFile(inputPath, 'source bytes', 'utf8')
  await transactions.commitOutputs([{ path: committedOutput, data: Buffer.from('result bytes') }])
  assert.equal(await readFile(committedOutput, 'utf8'), 'result bytes')
  assert.equal(await readFile(inputPath, 'utf8'), 'source bytes')

  const streamOutput = path.join(temporaryRoot, 'stream.bin')
  const streamed = await transactions.commitStream({
    path: streamOutput,
    stream: Readable.from([Buffer.from('stream '), Buffer.from('bytes')]),
    maxBytes: 32,
  })
  assert.equal(streamed.bytes, 12)
  assert.equal(await readFile(streamOutput, 'utf8'), 'stream bytes')

  const oversizedOutput = path.join(temporaryRoot, 'oversized.bin')
  await assert.rejects(
    transactions.commitStream({
      path: oversizedOutput,
      stream: Readable.from([Buffer.from('0123456789')]),
      maxBytes: 4,
    }),
    (error) => error?.code === 'ARTIFACT_TOO_LARGE',
  )
  await assert.rejects(readFile(oversizedOutput))

  let linkCount = 0
  const failingFileSystem = {
    ...nodeFileSystem,
    async link(source, destination) {
      linkCount += 1
      if (linkCount === 2) throw Object.assign(new Error('injected link failure'), { code: 'EIO' })
      return nodeFileSystem.link(source, destination)
    },
  }
  const failingTransactions = createLocalArtifactTransactions({ fileSystem: failingFileSystem })
  const rollbackDirectory = path.join(temporaryRoot, 'rollback')
  await nodeFileSystem.mkdir(rollbackDirectory)
  const rollbackOutputs = ['first.pdf', 'second.pdf'].map((name) => ({
    path: path.join(rollbackDirectory, name),
    data: Buffer.from(name),
  }))
  await assert.rejects(
    failingTransactions.commitOutputs(rollbackOutputs),
    (error) => error?.code === 'OUTPUT_WRITE_FAILED',
  )
  assert.deepEqual(await readdir(rollbackDirectory), [])

  process.stdout.write(`${JSON.stringify({
    ok: true,
    artifactTransaction: true,
    maximumPlanBytes: 1024 * 1024,
  })}\n`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
