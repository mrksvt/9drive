import path from 'node:path'

const DANGEROUS_CHARS = /[<>:"/\\|?*\x00-\x1f]/g
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g
const TRAILING_DOTS_SPACES = /[. ]+$/
const LEADING_DOTS_SPACES = /^[. ]+/

export function sanitizeFileName(fileName: string): string {
  // Remove path separators and dangerous characters
  let sanitized = fileName
    .replace(DANGEROUS_CHARS, '_')
    .replace(CONTROL_CHARS, '')
    .replace(TRAILING_DOTS_SPACES, '')
    .replace(LEADING_DOTS_SPACES, '')

  // Limit length to 255 characters (common filesystem limit)
  if (sanitized.length > 255) {
    const ext = path.extname(sanitized)
    const base = path.basename(sanitized, ext)
    sanitized = base.slice(0, 255 - ext.length) + ext
  }

  // Ensure filename is not empty
  if (!sanitized || sanitized.length === 0) {
    sanitized = 'unnamed_file'
  }

  return sanitized
}
