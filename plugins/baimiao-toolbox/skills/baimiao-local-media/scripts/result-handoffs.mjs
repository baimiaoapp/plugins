// Suggestions contain only local operations; following a result never authorizes another upload.
export const localResultHandoffs = (format) => {
  const normalized = String(format || '').toLowerCase()
  if (['pdf', 'application/pdf'].includes(normalized)) return ['compress-lossy', 'pdf-to-images', 'page-numbers', 'watermark', 'pdf-to-scanned']
  if (['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(normalized)) return ['word-to-pdf']
  if (['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'].includes(normalized)) return ['pptx-to-pdf']
  if (['image/png', 'image/jpeg'].includes(normalized)) return ['images-to-pdf', 'image-compress', 'document-scan', 'image-smart-cutout']
  if (normalized.startsWith('image/') && normalized !== 'image/gif') return ['image-convert', 'image-compress']
  return []
}
