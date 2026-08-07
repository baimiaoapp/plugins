import { readFile } from 'node:fs/promises'

const moduleUrl = new URL('../assets/qpdf/qpdf.mjs', import.meta.url)
const wasmUrl = new URL('../assets/qpdf/qpdf.wasm', import.meta.url)

export class QpdfError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'QpdfError'
    this.code = code
    this.details = details
  }
}

export const createQpdfNodeAdapter = async () => {
  let factory
  let wasmBinary
  try {
    const imported = await import(moduleUrl.href)
    factory = imported.default
    wasmBinary = await readFile(wasmUrl)
  } catch {
    throw new QpdfError('QPDF_UNAVAILABLE', 'The bundled QPDF runtime could not be loaded.')
  }

  if (typeof factory !== 'function') {
    throw new QpdfError('QPDF_UNAVAILABLE', 'The bundled QPDF module is invalid.')
  }

  let activeOutput = null
  let qpdf
  try {
    qpdf = await factory({
      wasmBinary,
      print(line) {
        activeOutput?.stdout.push(String(line))
      },
      printErr(line) {
        activeOutput?.stderr.push(String(line))
      },
    })
  } catch {
    throw new QpdfError('QPDF_UNAVAILABLE', 'The bundled QPDF runtime could not be initialized.')
  }

  if (!qpdf?.FS || typeof qpdf.callMain !== 'function') {
    throw new QpdfError('QPDF_UNAVAILABLE', 'The bundled QPDF runtime is missing required APIs.')
  }

  return new QpdfNodeAdapter(qpdf, {
    begin(output) {
      activeOutput = output
    },
    end() {
      activeOutput = null
    },
  })
}

class QpdfNodeAdapter {
  constructor(qpdf, outputCapture) {
    this.qpdf = qpdf
    this.outputCapture = outputCapture
    this.sequence = 0
  }

  getPageCount(file) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) => {
      const output = this.run(['--show-npages', 'input.pdf'], workDir)
      const pageCount = Number(output.stdout.findLast((line) => /^\d+$/.test(line.trim()))?.trim())
      if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new QpdfError('PROCESSING_FAILED', 'The PDF page count could not be determined.')
      }
      return pageCount
    })
  }

  merge(files) {
    const inputs = files.map((data, index) => ({ name: `input-${index}.pdf`, data }))
    return this.withJob(inputs, (workDir) => {
      const args = ['--empty', '--pages']
      inputs.forEach(({ name }) => args.push(name, '1-z'))
      args.push('--', 'merged.pdf')
      this.run(args, workDir)
      return [{ name: 'merged.pdf', data: this.read(`${workDir}/merged.pdf`) }]
    })
  }

  split(file, ranges) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) =>
      ranges.map((range) => {
        const label = formatRange(range)
        const outputName = `split-${label}.pdf`
        this.run(['input.pdf', '--pages', 'input.pdf', label, '--', outputName], workDir)
        return { name: outputName, data: this.read(`${workDir}/${outputName}`) }
      }),
    )
  }

  extract(file, ranges) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) => {
      const pageRange = ranges.map(formatRange).join(',')
      this.run(['input.pdf', '--pages', 'input.pdf', pageRange, '--', 'extracted.pdf'], workDir)
      return [{ name: 'extracted.pdf', data: this.read(`${workDir}/extracted.pdf`) }]
    })
  }

  optimize(file) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) => {
      this.run(
        [
          '--object-streams=generate',
          '--stream-data=compress',
          '--recompress-flate',
          'input.pdf',
          'optimized.pdf',
        ],
        workDir,
      )
      return [{ name: 'optimized.pdf', data: this.read(`${workDir}/optimized.pdf`) }]
    })
  }

  linearize(file) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) => {
      this.run(['--linearize', 'input.pdf', 'linearized.pdf'], workDir)
      return [{ name: 'linearized.pdf', data: this.read(`${workDir}/linearized.pdf`) }]
    })
  }

  repair(file) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) => {
      this.run(['input.pdf', 'repaired.pdf'], workDir)
      return [{ name: 'repaired.pdf', data: this.read(`${workDir}/repaired.pdf`) }]
    })
  }

  check(file) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) => {
      const output = this.run(['--check', 'input.pdf'], workDir)
      const messages = [...output.stdout, ...output.stderr]
        .map((line) => line.replaceAll('input.pdf', '[input]'))
        .filter(Boolean)
      return { valid: true, messages }
    })
  }

  encrypt(file, { userPassword, ownerPassword }) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) => {
      this.run(
        ['--encrypt', userPassword, ownerPassword || userPassword, '256', '--', 'input.pdf', 'encrypted.pdf'],
        workDir,
        { sensitive: true },
      )
      return [{ name: 'encrypted.pdf', data: this.read(`${workDir}/encrypted.pdf`) }]
    })
  }

  decrypt(file, { password }) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) => {
      this.run([`--password=${password}`, '--decrypt', 'input.pdf', 'decrypted.pdf'], workDir, {
        sensitive: true,
        passwordFailure: true,
      })
      return [{ name: 'decrypted.pdf', data: this.read(`${workDir}/decrypted.pdf`) }]
    })
  }

  rotate(file, ranges, angle) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) => {
      const pageRange = ranges.map(formatRange).join(',')
      const relativeAngle = angle > 0 ? `+${angle}` : `${angle}`
      this.run(['input.pdf', `--rotate=${relativeAngle}:${pageRange}`, 'rotated.pdf'], workDir)
      return [{ name: 'rotated.pdf', data: this.read(`${workDir}/rotated.pdf`) }]
    })
  }

  delete(file, remainingPages) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) => {
      this.run(
        ['input.pdf', '--pages', 'input.pdf', remainingPages.join(','), '--', 'deleted.pdf'],
        workDir,
      )
      return [{ name: 'deleted.pdf', data: this.read(`${workDir}/deleted.pdf`) }]
    })
  }

  reorder(file, pages) {
    return this.withJob([{ name: 'input.pdf', data: file }], (workDir) => {
      this.run(
        ['input.pdf', '--pages', 'input.pdf', pages.join(','), '--', 'reordered.pdf'],
        workDir,
      )
      return [{ name: 'reordered.pdf', data: this.read(`${workDir}/reordered.pdf`) }]
    })
  }

  withJob(inputs, callback) {
    const workDir = `/job-${Date.now()}-${this.sequence++}`
    this.qpdf.FS.mkdir(workDir)
    try {
      inputs.forEach(({ name, data }) => this.qpdf.FS.writeFile(`${workDir}/${name}`, data))
      return callback(workDir)
    } finally {
      this.removeWorkDir(workDir)
    }
  }

  run(args, workDir, options = {}) {
    const cwd = this.qpdf.FS.cwd()
    const output = { stdout: [], stderr: [] }
    let result
    this.qpdf.FS.chdir(workDir)
    this.outputCapture.begin(output)
    try {
      result = this.qpdf.callMain(args)
    } catch (error) {
      if (Number.isInteger(error?.status)) result = error.status
      else throw error
    } finally {
      this.outputCapture.end()
      this.qpdf.FS.chdir(cwd)
    }

    if (result !== 0 && result !== 3) {
      const diagnostic = output.stderr.join('\n').toLowerCase()
      const encrypted = /password|encrypted/.test(diagnostic)
      throw new QpdfError(
        options.passwordFailure ? 'INVALID_PASSWORD' : encrypted ? 'ENCRYPTED_PDF' : 'PROCESSING_FAILED',
        options.passwordFailure
          ? 'The PDF password was rejected.'
          : encrypted
            ? 'The PDF is encrypted and cannot be processed by this local skill.'
          : 'QPDF could not process the PDF.',
      )
    }
    return output
  }

  read(filePath) {
    return new Uint8Array(this.qpdf.FS.readFile(filePath))
  }

  removeWorkDir(workDir) {
    try {
      for (const item of this.qpdf.FS.readdir(workDir)) {
        if (item === '.' || item === '..') continue
        this.qpdf.FS.unlink(`${workDir}/${item}`)
      }
      this.qpdf.FS.rmdir(workDir)
    } catch {
      // Cleanup must not mask the processing result.
    }
  }
}

const formatRange = ({ start, end }) => (start === end ? `${start}` : `${start}-${end}`)
