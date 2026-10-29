const normalizeFamily = (name) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
export const selectFontPacks = (
  packs,
  codepoints,
  fontNames = [],
  documentCodepoints = codepoints,
) => {
  const pending = new Set(codepoints)
  const names = new Set(fontNames.map(normalizeFamily))
  const selected = []
  for (const pack of packs) {
    const contains = (ranges, code) => ranges.some(([start, end]) => code >= start && code <= end)
    const named = (pack.aliases || [pack.family]).some(
      (name) => name && names.has(normalizeFamily(name)),
    )
    if (pack.namedOnly) {
      if (named) selected.push(pack)
      continue
    }
    const preservesFallback = documentCodepoints.some((code) =>
      contains(pack.fallbackRanges || [], code),
    )
    const covered = [...pending].filter((code) => contains(pack.ranges, code))
    if (named || preservesFallback || covered.length) {
      selected.push(pack)
      covered.forEach((code) => pending.delete(code))
    }
  }
  return selected
}
