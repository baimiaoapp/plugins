import { getLocalOperation, LOCAL_OPERATION_NAMES } from './operation-catalog.mjs'

export class CliError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.details = details
  }
}

export const parseCliArguments = (argv) => {
  const [operation, ...tokens] = argv
  const definition = getLocalOperation(operation)
  if (!definition) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `Choose one supported operation: ${LOCAL_OPERATION_NAMES.join(', ')}.`,
    )
  }

  const options = { inputs: [] }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) {
      throw new CliError('INVALID_ARGUMENT', 'Every option must start with --.')
    }
    const name = token.slice(2)
    const key = name === 'output-dir' ? 'outputDir' : name
    if (key !== 'input' && !definition.allowedOptions.includes(key)) {
      throw new CliError('INVALID_ARGUMENT', `Unknown option: --${name}.`)
    }
    const value = tokens[index + 1]
    if (!value || value.startsWith('--')) {
      throw new CliError('INVALID_ARGUMENT', `Option --${name} requires a value.`)
    }
    index += 1

    if (name === 'input') {
      options.inputs.push(value)
      continue
    }
    if (options[key] !== undefined) {
      throw new CliError('INVALID_ARGUMENT', `Option --${name} can only be provided once.`)
    }
    options[key] = value
  }

  validateOperationOptions(operation, options)
  return { operation, options }
}

export const parsePageRanges = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliError('INVALID_PAGE_RANGE', 'Provide at least one page or page range.')
  }
  const ranges = value.split(',').map((part) => {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!match) {
      throw new CliError('INVALID_PAGE_RANGE', 'Use ranges such as 1, 1-3, or 1-3,8.')
    }
    const start = Number(match[1])
    const end = Number(match[2] || match[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new CliError('INVALID_PAGE_RANGE', 'Page ranges must be positive and ascending.')
    }
    return { start, end }
  })
  const keys = ranges.map(({ start, end }) => `${start}-${end}`)
  if (new Set(keys).size !== keys.length) {
    throw new CliError('INVALID_PAGE_RANGE', 'Duplicate page ranges are not allowed.')
  }
  return ranges
}

export const validateRangesForPageCount = (ranges, pageCount) => {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new CliError('PROCESSING_FAILED', 'The PDF page count could not be determined.')
  }
  if (ranges.some(({ end }) => end > pageCount)) {
    throw new CliError('INVALID_PAGE_RANGE', 'A page range exceeds the document page count.', {
      pageCount,
    })
  }
}

export const parsePageOrder = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliError('INVALID_PAGE_ORDER', 'Provide at least one page in the desired order.')
  }
  return value.split(',').flatMap((part) => {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!match) {
      throw new CliError('INVALID_PAGE_ORDER', 'Use an order such as 3,1,2 or 3,1-2.')
    }
    const start = Number(match[1])
    const end = Number(match[2] || match[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new CliError(
        'INVALID_PAGE_ORDER',
        'Page order values must be positive and ascending within ranges.',
      )
    }
    return Array.from({ length: end - start + 1 }, (_, index) => start + index)
  })
}

export const validatePageOrderForPageCount = (pages, pageCount) => {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new CliError('PROCESSING_FAILED', 'The PDF page count could not be determined.')
  }
  if (pages.some((page) => page > pageCount)) {
    throw new CliError('INVALID_PAGE_ORDER', 'A page number exceeds the document page count.', {
      pageCount,
    })
  }
}

export const parseRotationAngle = (value) => {
  const angle = Number(value)
  if (!Number.isSafeInteger(angle) || ![-90, 90, 180].includes(angle)) {
    throw new CliError('INVALID_ARGUMENT', 'Rotation angle must be -90, 90, or 180 degrees.')
  }
  return angle
}

const validateOperationOptions = (operation, options) => {
  const definition = getLocalOperation(operation)
  const minimumInputs = definition.minInputs
  const maximumInputs = definition.maxInputs
  if (options.inputs.length < minimumInputs || options.inputs.length > maximumInputs) {
    const expectation = maximumInputs === Infinity
      ? `at least ${minimumInputs}`
      : 'exactly one'
    throw new CliError('INVALID_ARGUMENT', `${operation} requires ${expectation} --input value(s).`)
  }

  for (const name of definition.requiredOptions) {
    const key = name === 'input' ? 'inputs' : name
    if (key === 'inputs' ? !options.inputs.length : !options[key]) {
      throw new CliError('INVALID_ARGUMENT', `Missing required option --${toOptionName(name)}.`)
    }
  }
  for (const [key, value] of Object.entries(options)) {
    if (key === 'inputs' || value === undefined) continue
    if (key !== 'inputs' && !definition.allowedOptions.includes(key)) {
      throw new CliError(
        'INVALID_ARGUMENT',
        `Option --${toOptionName(key)} is not valid for ${operation}.`,
      )
    }
  }
}

const toOptionName = (key) => key === 'outputDir' ? 'output-dir' : key
