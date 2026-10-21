import http, { IncomingMessage, ServerResponse } from "http";
import { randomBytes } from "crypto";
import { Transform } from "stream";
import zlib from "zlib";
import { CapturedBody, Headers, InspectorEntry, Packet } from "./interface";
import { WsManager } from "./ws_manager";

/** bytes of each request/response body kept for the inspector */
export const MAX_BODY_SIZE = 64 * 1024
/** entries kept per user */
export const MAX_HISTORY = 100
/** decompressed bodies larger than this are not decoded at all, protects against zip bombs */
const MAX_DECODED_SIZE = 16 * 1024 * 1024

const REPLAY_HEADER = 'x-gateway-replay'

const HOP_BY_HOP_HEADERS = [
    'connection',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
    'te',
    'trailer',
    'content-length',
]

class BodyCapture {
    chunks: Buffer[] = []
    captured = 0
    size = 0

    constructor(public limit: number) {}

    push(chunk: Buffer) {
        this.size += chunk.length
        if (this.captured < this.limit) {
            const part = chunk.subarray(0, this.limit - this.captured)
            this.chunks.push(part)
            this.captured += part.length
        }
    }

    result(contentEncoding: unknown): CapturedBody {
        const truncated = this.size > this.captured
        const raw = Buffer.concat(this.chunks)
        const { data, decoded, encoding } = decodeBody(raw, contentEncoding)
        return {
            size: this.size,
            data: data.subarray(0, this.limit).toString('base64'),
            truncated: truncated || data.length > this.limit,
            encoding,
            decoded,
        }
    }
}

/**
 * Remove the content-encoding from the captured bytes.
 * Truncated bodies are decoded as far as possible.
 */
export function decodeBody(data: Buffer, contentEncoding: unknown) {
    const encoding = typeof contentEncoding === 'string' && contentEncoding.trim() !== ''
        ? contentEncoding.trim().toLowerCase()
        : null

    if (encoding === null || encoding === 'identity' || data.length === 0) {
        return { data, decoded: true, encoding }
    }

    const flush = { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_DECODED_SIZE }

    try {
        switch (encoding) {
            case 'gzip':
            case 'x-gzip':
                return { data: zlib.gunzipSync(data, flush), decoded: true, encoding }
            case 'deflate':
                try {
                    return { data: zlib.inflateSync(data, flush), decoded: true, encoding }
                } catch (err) {
                    // some servers send raw deflate without the zlib wrapper
                    return { data: zlib.inflateRawSync(data, flush), decoded: true, encoding }
                }
            case 'br':
                return {
                    data: zlib.brotliDecompressSync(data, {
                        finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
                        maxOutputLength: MAX_DECODED_SIZE,
                    }),
                    decoded: true,
                    encoding,
                }
        }
    } catch (err) {}

    return { data, decoded: false, encoding }
}

export function normalizeHeaders(headers: unknown): Headers {
    const result: Headers = {}
    if (Array.isArray(headers)) {
        // either [[key, value], ...] or [key, value, key, value, ...]
        const pairs: unknown[][] = Array.isArray(headers[0])
            ? headers
            : headers.flatMap((v, i, arr) => i % 2 === 0 ? [[v, arr[i + 1]]] : [])
        for (const [key, value] of pairs) {
            result[String(key).toLowerCase()] = value as string
        }
    } else if (headers && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
            result[key.toLowerCase()] = value
        }
    }
    return result
}

function toBuffer(chunk: unknown, encoding: unknown) {
    if (Buffer.isBuffer(chunk)) return chunk
    if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8')
    if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    return null
}

export interface TrackOptions {
    remoteAddress: string,
}

export interface RequestTracker {
    entry: InspectorEntry,
    /** pipe the proxied request body through this to capture it */
    requestTap(): Transform,
}

export class Inspector {
    private history = new Map<string, InspectorEntry[]>()
    private nextId = new Map<string, number>()
    private replayToken = randomBytes(16).toString('hex')

    constructor (
        private wsManager: WsManager<Packet>,
        /** port of the local http server, used to replay requests */
        private getLocalPort: () => number,
        private bodyLimit = MAX_BODY_SIZE,
        private historyLimit = MAX_HISTORY,
    ) {}

    getHistory(userId: string) {
        return this.history.get(userId) ?? []
    }

    getEntry(userId: string, id: number) {
        return this.getHistory(userId).find(entry => entry.id === id)
    }

    private broadcast(userId: string, entry: InspectorEntry) {
        this.wsManager.broadcast(userId, { type: 'entry', id: entry.id, entry })
    }

    /** start recording a request, the response is captured until it finishes or the connection closes */
    track(userId: string, req: IncomingMessage, res: ServerResponse, options: TrackOptions): RequestTracker {
        const replayOf = this.takeReplayHeader(req)
        const id = this.nextId.get(userId) ?? 1
        this.nextId.set(userId, id + 1)

        const start = process.hrtime.bigint()
        const entry: InspectorEntry = {
            id,
            startTime: Date.now(),
            duration: null,
            state: 'pending',
            method: req.method ?? '',
            path: req.url ?? '',
            remoteAddress: options.remoteAddress,
            requestHeaders: { ...req.headers },
            requestBody: null,
            status: null,
            responseHeaders: null,
            responseBody: null,
            replayOf,
        }

        const history = this.history.get(userId) ?? []
        history.push(entry)
        while (history.length > this.historyLimit) history.shift()
        this.history.set(userId, history)

        let requestCapture: BodyCapture | null = null
        const responseCapture = new BodyCapture(this.bodyLimit)
        let headHeaders: Headers | null = null

        const originalWriteHead = res.writeHead
        res.writeHead = function (this: ServerResponse, ...args: any[]) {
            const headers = typeof args[1] === 'string' ? args[2] : args[1]
            headHeaders = { ...res.getHeaders(), ...normalizeHeaders(headers) }
            return (originalWriteHead as Function).apply(this, args)
        } as typeof res.writeHead

        const originalWrite = res.write
        res.write = function (this: ServerResponse, chunk: any, ...args: any[]) {
            const buffer = toBuffer(chunk, args[0])
            if (buffer) responseCapture.push(buffer)
            return (originalWrite as Function).call(this, chunk, ...args)
        } as typeof res.write

        const originalEnd = res.end
        res.end = function (this: ServerResponse, chunk?: any, ...args: any[]) {
            const buffer = typeof chunk === 'function' ? null : toBuffer(chunk, args[0])
            if (buffer) responseCapture.push(buffer)
            return (originalEnd as Function).call(this, chunk, ...args)
        } as typeof res.end

        let done = false
        const finish = (state: 'complete' | 'aborted') => {
            if (done) return
            done = true
            entry.state = state
            entry.duration = Number(process.hrtime.bigint() - start) / 1e6
            if (res.headersSent) {
                entry.status = res.statusCode
                entry.responseHeaders = headHeaders ?? normalizeHeaders(res.getHeaders())
                entry.responseBody = responseCapture.result(entry.responseHeaders['content-encoding'])
            }
            if (requestCapture) {
                entry.requestBody = requestCapture.result(req.headers['content-encoding'])
            }
            this.broadcast(userId, entry)
        }

        res.on('finish', () => finish('complete'))
        res.on('close', () => finish('aborted'))

        this.broadcast(userId, entry)

        return {
            entry,
            requestTap: () => {
                const capture = requestCapture = new BodyCapture(this.bodyLimit)
                return new Transform({
                    transform(chunk: Buffer, _encoding, callback) {
                        capture.push(chunk)
                        callback(null, chunk)
                    },
                })
            },
        }
    }

    /** read and remove the internal replay marker, ignores markers not from this process */
    private takeReplayHeader(req: IncomingMessage) {
        const value = req.headers[REPLAY_HEADER]
        delete req.headers[REPLAY_HEADER]
        if (typeof value !== 'string') return null

        const [token, id] = value.split(':')
        if (token !== this.replayToken || !/^\d+$/.test(id ?? '')) return null
        return Number(id)
    }

    /** send a recorded request again through the local http server, it shows up as a new entry */
    replay(userId: string, id: number) {
        const entry = this.getEntry(userId, id)
        if (!entry) {
            return Promise.reject(new Error(`request #${id} is no longer in history`))
        }
        if (entry.requestBody?.truncated) {
            return Promise.reject(new Error(`request #${id} body is larger than ${this.bodyLimit} bytes and was not fully captured`))
        }
        if (entry.requestBody && !entry.requestBody.decoded) {
            return Promise.reject(new Error(`request #${id} body uses unsupported encoding ${entry.requestBody.encoding}`))
        }

        const body = entry.requestBody ? Buffer.from(entry.requestBody.data, 'base64') : null
        const headers: http.OutgoingHttpHeaders = {}
        for (const [key, value] of Object.entries(entry.requestHeaders)) {
            if (HOP_BY_HOP_HEADERS.includes(key) || value === undefined) continue
            // the body is stored decoded
            if (key === 'content-encoding' && entry.requestBody) continue
            headers[key] = value
        }
        if (body) headers['content-length'] = body.length
        headers[REPLAY_HEADER] = `${this.replayToken}:${entry.id}`

        return new Promise<void>((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port: this.getLocalPort(),
                method: entry.method,
                path: entry.path,
                headers,
            }, (res) => {
                res.resume()
                res.on('end', () => resolve())
                res.on('error', reject)
            })
            req.on('error', reject)
            req.end(body ?? undefined)
        })
    }
}
