import { SFTPWrapper } from 'ssh2';
import { Readable, ReadableOptions } from 'stream';

/** bytes per read request, one sftp packet (ssh2 splits reads above ~254 KB into sequential ones) */
const CHUNK_SIZE = 64 * 1024
/**
 * Bytes all streams of one sftp session may have asked for and not passed on yet, together.
 * Over a tunnel a stream moves about in-flight bytes per round trip: 4 MB filled a 70 ms
 * Taiwan to Singapore path, more only queued up in front of the session's other requests.
 * The ssh channel window must be larger, see patches/ssh2+*.patch.
 */
const SESSION_BUDGET = 4 * 1024 * 1024
/** a stream always gets this many chunks, so a small file does not wait for a big one to finish */
const MIN_CHUNKS = 2

/**
 * Shares the read budget of one sftp session evenly between its streams. A stream alone gets
 * all of it, one that joins gets its share as soon as the others have that much less in flight.
 */
export class ReadBudget {
    private streams = new Set<object>()

    constructor(readonly bytes = SESSION_BUDGET) {}

    join(stream: object) {
        this.streams.add(stream)
    }

    leave(stream: object) {
        this.streams.delete(stream)
    }

    /** chunks one stream may have in flight */
    allowance(chunkSize: number) {
        return Math.max(MIN_CHUNKS, Math.floor(this.bytes / Math.max(1, this.streams.size) / chunkSize))
    }
}

const budgets = new WeakMap<SFTPWrapper, ReadBudget>()

function budgetOf(sftp: SFTPWrapper) {
    let budget = budgets.get(sftp)
    if (!budget) {
        budget = new ReadBudget()
        budgets.set(sftp, budget)
    }
    return budget
}

interface Chunk {
    position: number
    buffer: Buffer
    /** bytes read so far, a read may return less than asked */
    got: number
    done: boolean
}

export interface FastReadStreamOptions extends ReadableOptions {
    /** first byte to read, 0 by default */
    start?: number
    /** last byte to read, inclusive, the end of the file by default */
    end?: number
    /** size of the file when the caller has stat it already, saves a round trip */
    size?: number
    chunkSize?: number
    /** shared with the other streams of the session by default */
    budget?: ReadBudget
}

/**
 * Reads a file over sftp with many requests in flight. ssh2's createReadStream waits for each
 * chunk before asking for the next, so it moves one chunk per round trip, far too slow over a
 * tunnel. Chunks are passed on in file order, as they arrive.
 */
export class FastReadStream extends Readable {
    readonly budget: ReadBudget
    private chunkSize: number
    private handle: Buffer | null = null
    /** next byte to ask for */
    private position: number
    /** last byte to read, inclusive, known once the file is open */
    private last = -1
    /** asked for and not passed on yet, in file order */
    private chunks: Chunk[] = []
    /** the reader wants more, it said so in _read and push() did not say stop since */
    private wanted = false
    private ended = false

    constructor(private sftp: SFTPWrapper, readonly path: string, private options: FastReadStreamOptions = {}) {
        super(options)
        this.chunkSize = options.chunkSize ?? CHUNK_SIZE
        this.budget = options.budget ?? budgetOf(sftp)
        this.position = options.start ?? 0
    }

    _construct(callback: (err?: Error | null) => void) {
        this.sftp.open(this.path, 'r', (err, handle) => {
            if (err) return callback(err)
            this.handle = handle
            if (this.options.size !== undefined) return this.opened(this.options.size, callback)
            this.sftp.fstat(handle, (err, stats) => {
                if (err) return callback(err)
                this.opened(stats.size, callback)
            })
        })
    }

    private opened(size: number, callback: (err?: Error | null) => void) {
        this.last = Math.min(this.options.end ?? Infinity, size - 1)
        this.budget.join(this)
        callback()
    }

    _read() {
        this.wanted = true
        this.pump()
    }

    /** pass on the chunks that are ready in order, then ask for more up to the allowance */
    private pump() {
        if (this.destroyed || this.ended) return

        while (this.wanted && this.chunks.length > 0 && this.chunks[0].done) {
            this.wanted = this.push(this.chunks.shift()!.buffer)
        }

        if (this.chunks.length === 0 && this.position > this.last) {
            this.ended = true
            this.push(null)
            return
        }

        const allowance = this.budget.allowance(this.chunkSize)
        while (this.wanted && this.chunks.length < allowance && this.position <= this.last) {
            const size = Math.min(this.chunkSize, this.last - this.position + 1)
            const chunk: Chunk = { position: this.position, buffer: Buffer.allocUnsafe(size), got: 0, done: false }
            this.position += size
            this.chunks.push(chunk)
            this.readInto(chunk)
        }
    }

    private readInto(chunk: Chunk) {
        const remaining = chunk.buffer.length - chunk.got
        this.sftp.read(this.handle!, chunk.buffer, chunk.got, remaining, chunk.position + chunk.got, (err, bytesRead) => {
            // replies to reads that were in flight when the stream was destroyed
            if (this.destroyed) return
            if (err) return this.destroy(err)
            // ssh2 reports the end of the file as 0 bytes read, asking again would never end
            if (bytesRead === 0) return this.destroy(new Error(`${this.path} changed while it was read, it is shorter than expected`))

            chunk.got += bytesRead
            if (chunk.got < chunk.buffer.length) return this.readInto(chunk)
            chunk.done = true
            this.pump()
        })
    }

    _destroy(err: Error | null, callback: (err?: Error | null) => void) {
        this.budget.leave(this)
        const handle = this.handle
        this.handle = null
        if (!handle) return callback(err)
        // the data is out already or failed for another reason, a failed close changes nothing for the reader
        this.sftp.close(handle, () => callback(err))
    }
}

export default function getFastReadStream(sftp: SFTPWrapper, path: string, options?: FastReadStreamOptions) {
    return new FastReadStream(sftp, path, options);
}
