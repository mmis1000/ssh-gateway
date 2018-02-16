const {Readable} = require('stream');
const util = require("util");

function FastReadStream(channel, path, opts) {
    opts = opts || [];
    Readable.call(this, opts);
    this.channel = channel;
    this.path = path;
    
    // both inclusize
    this.start = opts.start || 0;
    this.end = opts.end || null;
    
    this.chunkSize = opts.chunkSize || 64 * 1024 // default 64kb
    this.parallel  = opts.parallel || 16; // parallel connections
    
    this.queueStart = null; // only known after got the actul size;
    this.queue = [];
    
    this.paused = true;
    this.statReaded = false;
    this.destroyed = false;
    
    this.handle = null;
}

util.inherits(FastReadStream, Readable)

FastReadStream.prototype._getHandle = function _getStat() {
    if (this.statReaded) {
        return;
    }
    this.statReaded = true;
    this.channel.open(this.path, 'r', this._onOpen.bind(this))
}

FastReadStream.prototype._onOpen =  function onOpen(err, handle) {
    if (this.destroyed) {
        return;
    }
    
    if (err) {
        return this.destroy(err)
    }
    
    this.handle = handle;
    
    this.channel.stat(this.path, this.onStatRead.bind(this));
}

FastReadStream.prototype.onStatRead = function onStatRead(err, stat) {
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
        this._fetch()
    }
}

FastReadStream.prototype._fetch = function _fetch() {
    if (this.destroyed) {
        return;
    }
    
    if (this.queue.length >= this.parallel) {
        return;
    }
    
    var nextChunkIndex = this.queueStart + this.queue.length;
    var position = nextChunkIndex * this.chunkSize;
    
    if (position < this.start) {
        position = this.start;
    }
    
    if (position > this.end) {
        return;
    }
    
    var end = (nextChunkIndex + 1 ) * this.chunkSize - 1;
    
    if (end >= this.end) {
        end = this.end;
    }
    
    var state = {
        finished: false,
        result: Buffer.allocUnsafe(end - position + 1),
        size: end - position + 1,
        got: 0,
        index: nextChunkIndex,
        last: (nextChunkIndex + 1) * this.chunkSize > this.end
    }
    
    // console.log(`index ${nextChunkIndex}, chunk start ${position}, chunk end ${end}, size ${end - position + 1}`)
    
    this.queue.push(state)
    // console.log('queue ++');
    
    // console.log(`#${state.index} next byte read ${state.got} ${state.size - state.got} ${position + state.got}`);
    this.channel.read(this.handle, state.result, 0, state.size, position, function onread(err, bytesRead, buffer, _position) {
        if (err) {
            return this.destroy(err);
        }
        
        
        state.got += bytesRead;
        
        if (state.got !== state.size) {
            this.channel.read(this.handle, state.result, state.got, state.size - state.got, position + state.got, onread.bind(this))
            // console.log(`#${state.index} next byte read ${state.got} ${state.size - state.got} ${position + state.got}`)
            return 
        }
        
        state.finished = true;
        
        this._doPush();
        this._fetch()
    }.bind(this))
    
    // loop until enough queue is got
    this._fetch()
}

FastReadStream.prototype._doPush = function _doPush() {
    var doPause = false;
    var item = null;
    while(this.queue.length > 0 && this.queue[0].finished) {
        this.queueStart++;
        // console.log('queueStart ++');
        item = this.queue.shift();
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

FastReadStream.prototype._read = function _read(size) {
    if (!this.statReaded) {
        this.paused = false;
        return this._getHandle();
    } else if (this.paused) {
        this.paused = false;
        this._doPush();
        this._fetch();
    }
}

FastReadStream.prototype._destroy = function _destroy(originalErr, cb) {
    try {
        this.push(null)
    } catch (err) {
        // nuzz
    }
    
    this.destroyed = true;
    
    if (this.handle) {
        this.channel.close(this.handle, function (err) {
            if (err) {
                cb(err);
            } else if (originalErr) {
                cb(originalErr)
            } else {
                cb();
            }
        })
    } else if (originalErr) {
        cb(originalErr)
    } else {
        cb();
    }
}

// mock for node < 8
if (!FastReadStream.prototype.destroy) {
    FastReadStream.prototype.destroy = function destroy(err) {
        this._destroy(err, function (err) {
            if (err) {
                this.emit('error', err);
            }
        }.bind(this));
    }
}

module.exports = function getFastReadStream(channel, path, opts) {
    return new FastReadStream(channel, path, opts);
}