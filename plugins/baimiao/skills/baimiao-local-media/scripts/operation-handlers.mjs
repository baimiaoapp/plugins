import path from 'node:path'

import { CliError, parsePageOrder, parsePageRanges, parseRotationAngle,
  validatePageOrderForPageCount, validateRangesForPageCount } from './cli-options.mjs'
import { MEDIA_OPERATION_NAMES } from './operation-catalog.mjs'

const PDF_MIME_TYPE = 'application/pdf'

export const createLocalOperationHandlers = ({ transactions, runMediaOperation }) => {
  const handlers = {
    merge: async ({ adapter, inputs, options }) => publishPdf({
      operation: 'merge', adapter, inputs, outputPaths: [await transactions.resolveOutputPath(options.output)],
      results: await adapter.merge(inputs.map(({ data }) => data)), transactions,
    }),

    split: async ({ adapter, inputs, options }) => {
      const ranges = parsePageRanges(options.ranges)
      const pageCount = adapter.getPageCount(inputs[0].data)
      validateRangesForPageCount(ranges, pageCount)
      const outputDir = await transactions.resolveOutputDirectory(options.outputDir)
      return publishPdf({
        operation: 'split', adapter, inputs,
        outputPaths: await Promise.all(ranges.map((range) => transactions.resolveOutputPath(
          path.join(outputDir, `split-${formatRange(range)}.pdf`),
        ))),
        results: await adapter.split(inputs[0].data, ranges), transactions,
      })
    },

    extract: async ({ adapter, inputs, options }) => {
      const ranges = parsePageRanges(options.pages)
      const pageCount = adapter.getPageCount(inputs[0].data)
      validateRangesForPageCount(ranges, pageCount)
      return publishPdf({
        operation: 'extract', adapter, inputs,
        outputPaths: [await transactions.resolveOutputPath(options.output)],
        results: await adapter.extract(inputs[0].data, ranges), transactions,
      })
    },

    optimize: ({ adapter, inputs, options }) => publishPdf({
      operation: 'optimize', adapter, inputs,
      outputPaths: [transactions.resolveOutputPath(options.output)],
      results: adapter.optimize(inputs[0].data), transactions,
    }),

    rotate: async ({ adapter, inputs, options }) => {
      const ranges = parsePageRanges(options.pages)
      const pageCount = adapter.getPageCount(inputs[0].data)
      validateRangesForPageCount(ranges, pageCount)
      return publishPdf({
        operation: 'rotate', adapter, inputs,
        outputPaths: [await transactions.resolveOutputPath(options.output)],
        results: await adapter.rotate(inputs[0].data, ranges, parseRotationAngle(options.angle)), transactions,
      })
    },

    delete: async ({ adapter, inputs, options }) => {
      const ranges = parsePageRanges(options.pages)
      const pageCount = adapter.getPageCount(inputs[0].data)
      validateRangesForPageCount(ranges, pageCount)
      const deletedPages = new Set(ranges.flatMap(({ start, end }) =>
        Array.from({ length: end - start + 1 }, (_, index) => start + index)))
      if (deletedPages.size >= pageCount) {
        throw new CliError('DELETE_ALL_PAGES', 'At least one page must remain in the PDF.', { pageCount })
      }
      const remainingPages = Array.from({ length: pageCount }, (_, index) => index + 1)
        .filter((page) => !deletedPages.has(page))
      return publishPdf({
        operation: 'delete', adapter, inputs,
        outputPaths: [await transactions.resolveOutputPath(options.output)],
        results: await adapter.delete(inputs[0].data, remainingPages), transactions,
      })
    },

    reorder: async ({ adapter, inputs, options }) => {
      const pages = parsePageOrder(options.order)
      const pageCount = adapter.getPageCount(inputs[0].data)
      validatePageOrderForPageCount(pages, pageCount)
      return publishPdf({
        operation: 'reorder', adapter, inputs,
        outputPaths: [await transactions.resolveOutputPath(options.output)],
        results: await adapter.reorder(inputs[0].data, pages), transactions,
      })
    },

    encrypt: async ({ adapter, inputs, options, readSecret }) => publishPdf({
      operation: 'encrypt', adapter, inputs,
      outputPaths: [await transactions.resolveOutputPath(options.output)],
      results: await adapter.encrypt(inputs[0].data, await readSecret('encrypt')), transactions,
    }),

    decrypt: async ({ adapter, inputs, options, readSecret }) => publishPdf({
      operation: 'decrypt', adapter, inputs,
      outputPaths: [await transactions.resolveOutputPath(options.output)],
      results: await adapter.decrypt(inputs[0].data, await readSecret('decrypt')), transactions,
    }),

    check: ({ adapter, inputs, operation, backend }) => ({
      ok: true, operation, backend, report: adapter.check(inputs[0].data), outputs: [],
    }),

    repair: ({ adapter, inputs, options }) => publishPdf({
      operation: 'repair', adapter, inputs,
      outputPaths: [transactions.resolveOutputPath(options.output)],
      results: adapter.repair(inputs[0].data), transactions,
    }),

    linearize: ({ adapter, inputs, options }) => publishPdf({
      operation: 'linearize', adapter, inputs,
      outputPaths: [transactions.resolveOutputPath(options.output)],
      results: adapter.linearize(inputs[0].data), transactions,
    }),

    'reorder-plan': async ({ adapter, inputs, options }) => publishPdf({
      operation: 'reorder-plan', adapter, inputs,
      outputPaths: [await transactions.resolveOutputPath(options.output)],
      results: await adapter.reorder(inputs[0].data, await transactions.readJsonPlan(options.plan)), transactions,
    }),

    'page-numbers': async ({ adapter, inputs, options }) => {
      const plan = options.plan ? await transactions.readJsonPlan(options.plan) : {}
      if (options.pages) {
        if (plan.ranges !== undefined) {
          throw new CliError('INVALID_ARGUMENT', 'Select pages with either --pages or plan.ranges, not both.')
        }
        plan.ranges = parsePageRanges(options.pages)
      }
      return publishPdf({
        operation: 'page-numbers', adapter, inputs,
        outputPaths: [await transactions.resolveOutputPath(options.output)],
        results: await adapter.addPageNumbers(inputs[0].data, plan), transactions,
      })
    },

    'metadata-cleanup': ({ adapter, inputs, options }) => publishPdf({
      operation: 'metadata-cleanup', adapter, inputs,
      outputPaths: [transactions.resolveOutputPath(options.output)],
      results: adapter.cleanupMetadata(inputs[0].data), transactions,
    }),

    watermark: async ({ adapter, inputs, options, resolveImageInput }) => {
      const plan = await transactions.readJsonPlan(options.plan)
      if (plan.mode === 'image') {
        if (typeof plan.imagePath !== 'string') {
          throw new CliError('INVALID_PLAN', 'Image watermark plans require an absolute imagePath.')
        }
        plan.image = await resolveImageInput(plan.imagePath)
        delete plan.imagePath
      }
      return publishPdf({
        operation: 'watermark', adapter, inputs,
        outputPaths: [await transactions.resolveOutputPath(options.output)],
        results: await adapter.addWatermark(inputs[0].data, plan), transactions,
      })
    },

    'images-to-pdf': async ({ adapter, inputs, options }) => publishPdf({
      operation: 'images-to-pdf', adapter, inputs,
      outputPaths: [transactions.resolveOutputPath(options.output)],
      results: adapter.imagesToPdf(inputs, options.plan ? await transactions.readJsonPlan(options.plan) : {}), transactions,
    }),
  }

  for (const name of MEDIA_OPERATION_NAMES) {
    handlers[name] = async ({ operation, options }) => {
      if (typeof runMediaOperation !== 'function') {
        throw new CliError('PROCESSING_FAILED', 'The media Operation runner is unavailable.')
      }
      return runMediaOperation({ operation, options, transactions })
    }
  }
  return Object.freeze(handlers)
}

const publishPdf = async ({ operation, adapter, inputs, outputPaths, results, transactions }) => {
  const resolvedResults = await results
  const resolvedPaths = await Promise.all(outputPaths)
  if (!Array.isArray(resolvedResults) || resolvedResults.length !== resolvedPaths.length) {
    throw new CliError('PROCESSING_FAILED', 'The PDF runtime returned an unexpected result count.')
  }
  await transactions.commitOutputs(resolvedResults.map((result, index) => ({
    data: result.data,
    path: resolvedPaths[index],
  })))
  return {
    ok: true,
    operation,
    backend: adapter.constructor?.name === 'QpdfNodeAdapter' ? 'qpdf.wasm' : 'pdf-lib',
    outputs: resolvedResults.map((result, index) => ({
      path: resolvedPaths[index],
      type: PDF_MIME_TYPE,
      size: result.data.byteLength,
      ...(result.metadataCleanup ? { metadataCleanup: result.metadataCleanup } : {}),
    })),
  }
}

const formatRange = ({ start, end }) => (start === end ? `${start}` : `${start}-${end}`)
