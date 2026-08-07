import { randomUUID } from 'node:crypto'
import * as nodeFileSystem from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import process from 'node:process'

import { CliError } from './cli-options.mjs'

const MAX_JSON_PLAN_BYTES = 1024 * 1024

export const createLocalArtifactTransactions = ({
  fileSystem = nodeFileSystem,
  createId = randomUUID,
} = {}) => Object.freeze({
  async readJsonPlan(planPath) {
    if (!path.isAbsolute(planPath)) {
      throw new CliError('INVALID_PLAN', 'JSON plan paths must be absolute.')
    }

    let resolved
    let info
    try {
      resolved = await fileSystem.realpath(planPath)
      info = await fileSystem.stat(resolved)
    } catch {
      throw new CliError('INVALID_PLAN', 'The JSON plan does not exist or cannot be read.')
    }
    if (!info.isFile() || info.size < 1 || info.size > MAX_JSON_PLAN_BYTES) {
      throw new CliError(
        'INVALID_PLAN',
        'A JSON plan must be a non-empty regular file no larger than 1 MiB.',
      )
    }

    try {
      const data = await fileSystem.readFile(resolved)
      if (data.byteLength > MAX_JSON_PLAN_BYTES) throw new Error('plan grew while reading')
      const value = JSON.parse(data.toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
      return value
    } catch {
      throw new CliError('INVALID_PLAN', 'The JSON plan must contain one valid JSON object.')
    }
  },

  async resolveOutputDirectory(outputDir) {
    return resolveOutputDirectory(fileSystem, outputDir)
  },

  async resolveOutputPath(outputPath) {
    return resolveOutputPath(fileSystem, outputPath)
  },

  async commitOutputs(outputs) {
    const prepared = await Promise.all(outputs.map(async (output) => ({
      ...output,
      path: await resolveOutputPath(fileSystem, output.path),
    })))
    if (new Set(prepared.map((output) => output.path)).size !== prepared.length) {
      throw new CliError('OUTPUT_COLLISION', 'Multiple outputs resolve to the same path.')
    }
    await commitOutputs(fileSystem, createId, prepared)
    return prepared
  },

  async commitStream(output) {
    const prepared = {
      ...output,
      path: await resolveOutputPath(fileSystem, output.path),
    }
    await commitStream(fileSystem, createId, prepared)
    const info = await fileSystem.stat(prepared.path)
    return { ...prepared, bytes: info.size }
  },
})

const resolveOutputDirectory = async (fileSystem, outputDir) => {
  if (!path.isAbsolute(outputDir)) {
    throw new CliError('INVALID_ARGUMENT', 'Output directories must be absolute.')
  }
  try {
    const resolved = await fileSystem.realpath(outputDir)
    if (!(await fileSystem.stat(resolved)).isDirectory()) throw new Error('not a directory')
    return resolved
  } catch {
    throw new CliError('OUTPUT_WRITE_FAILED', 'The output directory does not exist or is not usable.')
  }
}

const resolveOutputPath = async (fileSystem, outputPath) => {
  if (!path.isAbsolute(outputPath)) {
    throw new CliError('INVALID_ARGUMENT', 'Output paths must be absolute.')
  }
  const directory = await resolveOutputDirectory(fileSystem, path.dirname(outputPath))
  const resolved = path.join(directory, path.basename(outputPath))
  try {
    await fileSystem.lstat(resolved)
    throw new CliError('OUTPUT_EXISTS', 'The output path already exists.')
  } catch (error) {
    if (error instanceof CliError) throw error
    if (error?.code !== 'ENOENT') {
      throw new CliError('OUTPUT_WRITE_FAILED', 'The output path cannot be inspected safely.')
    }
  }
  return resolved
}

const commitOutputs = async (fileSystem, createId, outputs) => {
  const staged = []
  const created = []
  try {
    for (const output of outputs) {
      const temporaryPath = path.join(
        path.dirname(output.path),
        `.${path.basename(output.path)}.${process.pid}.${createId()}.tmp`,
      )
      await fileSystem.writeFile(temporaryPath, output.data, { flag: 'wx', mode: 0o600 })
      staged.push({
        temporaryPath,
        outputPath: output.path,
        identity: fileIdentity(await fileSystem.stat(temporaryPath)),
      })
    }
    for (const item of staged) {
      try {
        await fileSystem.link(item.temporaryPath, item.outputPath)
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw new CliError('OUTPUT_EXISTS', 'The output path already exists.')
        }
        throw new CliError('OUTPUT_WRITE_FAILED', 'An output file could not be committed safely.')
      }
      created.push(item)
    }
  } catch (error) {
    const rollbackFailures = await rollbackCreatedOutputs(fileSystem, created)
    if (rollbackFailures.length) {
      throw new CliError(
        'ROLLBACK_FAILED',
        'Some outputs from the failed transaction could not be removed safely.',
        { paths: rollbackFailures },
      )
    }
    throw error
  } finally {
    await Promise.all(
      staged.map(({ temporaryPath }) => fileSystem.unlink(temporaryPath).catch(() => undefined)),
    )
  }
}

const commitStream = async (fileSystem, createId, output) => {
  const temporaryPath = path.join(
    path.dirname(output.path),
    `.${path.basename(output.path)}.${process.pid}.${createId()}.tmp`,
  )
  let handle
  let created = false
  try {
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600)
    let bytes = 0
    const source = output.stream instanceof Uint8Array
      ? Readable.from([output.stream])
      : output.stream
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
      throw new CliError('INVALID_ARTIFACT', 'The artifact source must be a readable stream.')
    }
    for await (const chunk of source) {
      const data = Buffer.from(chunk)
      bytes += data.byteLength
      if (output.maxBytes !== undefined && bytes > output.maxBytes) {
        throw new CliError('ARTIFACT_TOO_LARGE', 'The artifact exceeds the local limit.')
      }
      await handle.write(data)
    }
    await handle.close()
    handle = undefined
    const identity = fileIdentity(await fileSystem.stat(temporaryPath))
    try {
      await fileSystem.link(temporaryPath, output.path)
      created = true
    } catch (error) {
      if (error?.code === 'EEXIST') throw new CliError('OUTPUT_EXISTS', 'The output path already exists.')
      throw new CliError('OUTPUT_WRITE_FAILED', 'An output file could not be committed safely.')
    }
    return { bytes, identity }
  } catch (error) {
    if (created) {
      const failures = await rollbackCreatedOutputs(fileSystem, [{ outputPath: output.path, identity: fileIdentity(await fileSystem.stat(output.path)) }])
      if (failures.length) throw new CliError('ROLLBACK_FAILED', 'Some outputs from the failed transaction could not be removed safely.', { paths: failures })
    }
    throw error
  } finally {
    await handle?.close().catch(() => {})
    await fileSystem.unlink(temporaryPath).catch(() => {})
  }
}

const rollbackCreatedOutputs = async (fileSystem, created) => {
  const failures = []
  for (const item of [...created].reverse()) {
    try {
      const current = await fileSystem.lstat(item.outputPath)
      if (!sameFile(item.identity, fileIdentity(current))) {
        failures.push(item.outputPath)
        continue
      }
      await fileSystem.unlink(item.outputPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') failures.push(item.outputPath)
    }
  }
  return failures
}

const fileIdentity = (info) => ({ dev: info.dev, ino: info.ino })
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino
