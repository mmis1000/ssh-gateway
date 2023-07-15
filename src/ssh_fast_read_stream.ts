import { SFTPWrapper, Stats } from 'ssh2';
import { Readable, ReadableOptions } from 'stream';

interface Task {
    finished: boolean
    result: Buffer
    size: number
    got: number
    index: number
    last: boolean
}

interface FastReadStreamOpts extends ReadableOptions {
    start?: number
    end?: number
    chunkSize?: number
    parallel?: number
}

export class FastReadStream extends Readable {
    channel: SFTPWrapper
    start: number
    end: number | null
    path: string
    chunkSize: number
    parallel: number
    queueStart: null | number
    queue: Task[]
    paused: boolean
    statReaded: boolean
    handle: Buffer | null


    constructor(channel: SFTPWrapper, path: string, opts?: FastReadStreamOpts) {
        opts = opts || {};
        super(opts)

        this.channel = channel;
        this.path = path;

        // both inclusive
        this.start = opts.start || 0;
        this.end = opts.end || null;

        this.chunkSize = opts.chunkSize || 64 * 1024; // default 64kb
        this.parallel = opts.parallel || 16; // parallel connections

        this.queueStart = null; // only known after got the actual size;
        this.queue = [];

        this.paused = true;
        this.statReaded = false;
        this.destroyed = false;

        this.handle = null;
    }
    _getHandle() {
        if (this.statReaded) {
            return;
        }
        this.statReaded = true;
        this.channel.open(this.path, 'r', this._onOpen.bind(this));
    }
    _onOpen(err: Error | undefined, handle: Buffer) {
        if (this.destroyed) {
            return;
        }

        if (err) {
            return this.destroy(err);
        }

        this.handle = handle;

        this.channel.stat(this.path, this.onStatRead.bind(this));
    }
    onStatRead(err: Error | undefined, stat: Stats) {
        if (this.destroyed) {
            return;
        }

        if (err) {
            return this.destroy(err);
        }


        this.start = (stat.size - 1 >= this.start) ? this.start : stat.size;
        this.end = (this.end !== null && stat.size - 1 >= this.end) ? this.end : stat.size - 1;

        if (this.start >= this.end + 1) {
            // 0 size read (wtf?)
            this.destroy();
        }

        this.queueStart = Math.floor(this.start / this.chunkSize);

        if (!this.paused) {
            this._fetch();
        }
    }
    _fetch() {
        if (this.destroyed) {
            return;
        }

        if (this.queue.length >= this.parallel) {
            return;
        }

        var nextChunkIndex = this.queueStart! + this.queue.length;
        var position = nextChunkIndex * this.chunkSize;

        if (position < this.start) {
            position = this.start;
        }

        if (position > this.end!) {
            return;
        }

        var end = (nextChunkIndex + 1) * this.chunkSize - 1;

        if (end >= this.end!) {
            end = this.end!;
        }

        var state = {
            finished: false,
            result: Buffer.allocUnsafe(end - position + 1),
            size: end - position + 1,
            got: 0,
            index: nextChunkIndex,
            last: (nextChunkIndex + 1) * this.chunkSize > this.end!
        };

        // console.log(`index ${nextChunkIndex}, chunk start ${position}, chunk end ${end}, size ${end - position + 1}`)
        this.queue.push(state);
        // console.log('queue ++');
        // console.log(`#${state.index} next byte read ${state.got} ${state.size - state.got} ${position + state.got}`);
        const onread = (err: Error | undefined, bytesRead: number, buffer: Buffer, _position: number) => {
            if (err) {
                return this.destroy(err);
            }


            state.got += bytesRead;

            if (state.got !== state.size) {
                this.channel.read(this.handle!, state.result, state.got, state.size - state.got, position + state.got, onread);
                // console.log(`#${state.index} next byte read ${state.got} ${state.size - state.got} ${position + state.got}`)
                return;
            }

            state.finished = true;

            this._doPush();
            this._fetch();
        }
        this.channel.read(this.handle!, state.result, 0, state.size, position, onread);

        // loop until enough queue is got
        this._fetch();
    }
    _doPush() {
        var doPause = false;
        var item: Task | null = null;
        while (this.queue.length > 0 && this.queue[0].finished) {
            this.queueStart!++;
            // console.log('queueStart ++');
            item = this.queue.shift()!;
            // console.log('queue --');
            doPause = !this.push(item.result);
            // console.log(`put chunk #${item.index}`);
            if (item.last) {
                this.push(null);
                this.destroy();
            }

            if (doPause) {
                this.paused = true;
                break;
            }
        }
    }
    _read(size: number) {
        if (!this.statReaded) {
            this.paused = false;
            return this._getHandle();
        } else if (this.paused) {
            this.paused = false;
            this._doPush();
            this._fetch();
        }
    }
    _destroy(originalErr: Error | null | undefined, cb: (err?: Error | undefined) => void) {
        try {
            this.push(null);
        } catch (err) {
            // nuzz
        }

        this.destroyed = true;

        if (this.handle) {
            this.channel.close(this.handle, function (err) {
                if (err) {
                    cb(err);
                } else if (originalErr) {
                    cb(originalErr);
                } else {
                    cb();
                }
            });
        } else if (originalErr) {
            cb(originalErr);
        } else {
            cb();
        }
    }
    destroy(err?: Error | undefined) {
        this._destroy(err, (err) => {
            if (err) {
                this.emit('error', err);
            }
        });
        return this
    }
}

export default function getFastReadStream(channel: SFTPWrapper, path: string, opts?: FastReadStreamOpts) {
    return new FastReadStream(channel, path, opts);
}