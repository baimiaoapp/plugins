import { readFile } from 'node:fs/promises'

const codecModuleUrl = new URL('../assets/image-codec/image-codec.mjs', import.meta.url)
const codecWasmUrl = new URL('../assets/image-codec/image-codec.wasm', import.meta.url)
const jpxModuleUrl = new URL('../assets/image-codec/jpx-codec.mjs', import.meta.url)
const jpxWasmUrl = new URL('../assets/image-codec/jpx-codec.wasm', import.meta.url)

let adapterPromise

export const createImageCodecNodeAdapter = async () => {
  if (!adapterPromise) adapterPromise = loadAdapter()
  return adapterPromise
}

const loadAdapter = async () => {
  const [{ default: codecFactory }, { default: jpxFactory }, codecWasm, jpxWasm] = await Promise.all([
    import(codecModuleUrl.href),
    import(jpxModuleUrl.href),
    readFile(codecWasmUrl),
    readFile(jpxWasmUrl),
  ])
  const [codec, jpx] = await Promise.all([
    codecFactory({ wasmBinary: codecWasm }),
    jpxFactory({ wasmBinary: jpxWasm }),
  ])
  if (
    typeof codec?.reencodeJpeg !== 'function' ||
    typeof codec?.encodeRgbJpeg !== 'function' ||
    typeof codec?.encodeGrayJpeg !== 'function' ||
    typeof codec?.encodeCmykJpeg !== 'function' ||
    typeof codec?.encodeIndexedRgbJpeg !== 'function' ||
    typeof codec?.encodeLabJpeg !== 'function'
  ) {
    throw new Error('The bundled image codec is missing required exports.')
  }
  return {
    available: true,
    backend: 'image-codec.wasm',
    capabilities: { jpxDecode: typeof jpx?.decodePdfImage === 'function' },
    reencodeJpeg: (input) => codec.reencodeJpeg(input),
    encodeRgbJpeg: (input) => codec.encodeRgbJpeg(input),
    encodeGrayJpeg: (input) => codec.encodeGrayJpeg(input),
    encodeCmykJpeg: (input) => codec.encodeCmykJpeg(input),
    encodeIndexedRgbJpeg: (input) => codec.encodeIndexedRgbJpeg(input),
    encodeLabJpeg: (input) => codec.encodeLabJpeg(input),
    decodePdfImage(input) {
      if (input?.filters?.includes?.('JPXDecode') && typeof jpx?.decodePdfImage === 'function') {
        return jpx.decodePdfImage(input)
      }
      return typeof codec.decodePdfImage === 'function' ? codec.decodePdfImage(input) : null
    },
  }
}
