/**
 * Reads a file of a folder share from its own domain. The gateway lets this page read folder
 * shares with CORS, with the visitor password the browser already has for that domain. The bytes
 * are only ever shown as text here, nothing of them is rendered as a page
 */

export type RemoteErrorKind = 'auth' | 'missing' | 'forbidden' | 'offline' | 'changed' | 'unreachable' | 'failed'

export class RemoteFileError extends Error {
  constructor(readonly kind: RemoteErrorKind, message: string) {
    super(message)
  }
}

export interface RemoteFile {
  url: string
  name: string
  size: number
  /** every range must come with the same one, or the file changed while open */
  etag: string | null
}

const CHANGED = 'The file changed while it was open. Reload the page to see the current version.'

/** the file from the location fragment, which never reaches the server */
export function fileUrlFromHash(hash: string): URL {
  let value = hash.replace(/^#/, '')
  // also take links that encoded the whole url
  if (/^https?%3A/i.test(value)) value = decodeURIComponent(value)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RemoteFileError('failed', 'This link does not name a file to show.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RemoteFileError('failed', 'This link does not name a file to show.')
  }
  url.hash = ''
  return url
}

async function request(url: string, init: RequestInit = {}) {
  try {
    return await fetch(url, { ...init, credentials: 'include', cache: 'no-store' })
  } catch {
    // the browser hides why: offline, or a site that is not a folder share of this gateway
    throw new RemoteFileError('unreachable', 'Could not read the file. Only files of folder shares on this gateway can be viewed here.')
  }
}

function statusError(status: number) {
  switch (status) {
    case 401: return new RemoteFileError('auth', 'This share needs a user name and password. Open its folder in this browser and sign in there, then reload this page.')
    case 404: return new RemoteFileError('missing', 'There is no file at this address.')
    case 403: return new RemoteFileError('forbidden', 'This file can not be shared.')
    case 502: return new RemoteFileError('offline', 'The computer sharing this file is not connected right now. Try again later.')
    default: return new RemoteFileError('failed', `The gateway answered with status ${status}.`)
  }
}

/**
 * the file and its first `sampleSize` bytes, from one request: every request is a round trip
 * through the tunnel. The size comes from Content-Range, which an empty file answers with 416
 */
export async function openRemoteFile(url: URL, sampleSize: number): Promise<{ file: RemoteFile, sample: Uint8Array }> {
  const res = await request(url.href, { headers: { Range: `bytes=0-${sampleSize - 1}` } })
  if (!res.ok && res.status !== 416) throw statusError(res.status)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const total = /\/(\d+)$/.exec(res.headers.get('Content-Range') ?? '')?.[1]
  // 200 is all of the file
  const size = res.status === 200 ? bytes.length : Number(total)
  if (!Number.isSafeInteger(size)) throw new RemoteFileError('failed', 'The gateway did not say how large the file is.')
  const last = url.pathname.split('/').pop() ?? ''
  let name = last
  try {
    name = decodeURIComponent(last)
  } catch {}
  const file = { url: url.href, name: name || '/', size, etag: res.headers.get('ETag') }
  return { file, sample: res.status === 416 ? new Uint8Array(0) : bytes.slice(0, sampleSize) }
}

/** bytes start up to end, end not included, which must lie within the file */
export async function readRange(file: RemoteFile, start: number, end: number): Promise<Uint8Array> {
  if (end <= start) return new Uint8Array(0)
  const res = await request(file.url, { headers: { Range: `bytes=${start}-${end - 1}` } })
  if (res.status === 416) throw new RemoteFileError('changed', CHANGED)
  if (!res.ok) throw statusError(res.status)
  if (file.etag && res.headers.get('ETag') !== file.etag) throw new RemoteFileError('changed', CHANGED)
  const bytes = new Uint8Array(await res.arrayBuffer())
  // 200 is all of the file
  return res.status === 206 ? bytes : bytes.slice(start, end)
}

/** NUL bytes or broken UTF-8 in the sample. A sample cut short may end inside a character */
export function looksLikeText(sample: Uint8Array, complete: boolean) {
  if (sample.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: !complete })
    return true
  } catch {
    return false
  }
}

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB']

/** 1023 B, 1.5 KB, 120 MB, like the folder listing */
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${SIZE_UNITS[unit]}`
}
