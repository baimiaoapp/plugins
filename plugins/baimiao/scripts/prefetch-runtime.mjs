import { RUNTIME_BUNDLES } from '../skills/baimiao-local-media/scripts/runtime-assets.mjs'
import { ensureRuntimeBundle, getRuntimeCacheDirectory } from '../skills/baimiao-local-media/scripts/runtime-cache.mjs'

const requested = process.argv.slice(2)
const bundles = requested.length && !requested.includes('all') ? requested : Object.keys(RUNTIME_BUNDLES)
for (const name of bundles) {
  if (!RUNTIME_BUNDLES[name]) throw new Error(`Unknown runtime bundle: ${name}`)
  await ensureRuntimeBundle(name)
}

console.log(JSON.stringify({ ok: true, bundles, cacheDirectory: getRuntimeCacheDirectory() }))
