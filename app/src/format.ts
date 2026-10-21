import type { CapturedBody, Headers, InspectorEntry } from './interface'

export function headerValue(headers: Headers | null, name: string) {
  const value = headers?.[name.toLowerCase()]
  if (value === undefined) return ''
  return Array.isArray(value) ? value.join(', ') : String(value)
}

export function headerList(headers: Headers | null) {
  const result: [string, string][] = []
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) result.push([key, String(item)])
  }
  return result.sort((a, b) => a[0].localeCompare(b[0]))
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function formatDuration(ms: number | null) {
  if (ms === null) return ''
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatTime(epoch: number) {
  const date = new Date(epoch)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

export function statusClass(entry: InspectorEntry) {
  if (entry.state === 'aborted' && entry.status === null) return 'status-error'
  if (entry.status === null) return 'status-pending'
  if (entry.status >= 500) return 'status-error'
  if (entry.status >= 400) return 'status-warn'
  if (entry.status >= 300) return 'status-redirect'
  return 'status-ok'
}

export function statusText(entry: InspectorEntry) {
  if (entry.status !== null) return String(entry.status)
  return entry.state === 'aborted' ? 'ERR' : '…'
}

export function decodeBase64(data: string) {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export type BodyKind = 'empty' | 'encoded' | 'image' | 'json' | 'form' | 'text' | 'binary'

export interface BodyView {
  kind: BodyKind
  bytes: Uint8Array
  text: string
  mime: string
}

function looksBinary(bytes: Uint8Array, text: string) {
  const sample = bytes.subarray(0, 4096)
  if (sample.includes(0)) return true
  const replacements = text.slice(0, 4096).split('�').length - 1
  return replacements > sample.length / 20
}

export function viewBody(body: CapturedBody | null, contentType: string): BodyView {
  const mime = contentType.split(';')[0].trim().toLowerCase()
  if (!body || body.size === 0) return { kind: 'empty', bytes: new Uint8Array(), text: '', mime }

  const bytes = decodeBase64(body.data)
  if (!body.decoded) return { kind: 'encoded', bytes, text: '', mime }
  if (mime.startsWith('image/') && !body.truncated) return { kind: 'image', bytes, text: '', mime }

  const text = new TextDecoder('utf-8').decode(bytes)
  if (mime === 'application/x-www-form-urlencoded') return { kind: 'form', bytes, text, mime }
  if (mime.endsWith('json') || mime.endsWith('+json')) return { kind: 'json', bytes, text, mime }
  if (looksBinary(bytes, text)) return { kind: 'binary', bytes, text: '', mime }
  return { kind: 'text', bytes, text, mime }
}

export function prettyJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), undefined, 2)
  } catch (err) {
    // truncated or invalid, show as is
    return text
  }
}

export function hexDump(bytes: Uint8Array, limit = 4096) {
  const lines: string[] = []
  const shown = bytes.subarray(0, limit)
  for (let offset = 0; offset < shown.length; offset += 16) {
    const row = shown.subarray(offset, offset + 16)
    const hex = Array.from(row, b => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(row, b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`)
  }
  if (bytes.length > limit) lines.push(`… ${bytes.length - limit} more bytes`)
  return lines.join('\n')
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

const CURL_SKIPPED_HEADERS = ['host', 'content-length', 'connection', 'accept-encoding', 'x-forwarded-for']

export function toCurl(entry: InspectorEntry, publicUrl: string) {
  const base = new URL(publicUrl)
  const host = headerValue(entry.requestHeaders, 'host') || base.host
  const parts = ['curl', '-X', entry.method, shellQuote(`${base.protocol}//${host}${entry.path}`)]

  for (const [key, value] of headerList(entry.requestHeaders)) {
    if (CURL_SKIPPED_HEADERS.includes(key)) continue
    if (key === 'content-encoding' && entry.requestBody?.decoded) continue
    parts.push('-H', shellQuote(`${key}: ${value}`))
  }

  const body = entry.requestBody
  if (body && body.size > 0) {
    const text = new TextDecoder('utf-8').decode(decodeBase64(body.data))
    parts.push('--data-binary', shellQuote(text))
  }

  return parts.join(' ')
}
