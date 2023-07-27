type CancelCallback = () => void
type HandlerCallback<T> = (value: T) => void
type SubscribeHandlerCallback<T> = (fn: HandlerCallback<T>, hasEmitted: boolean, lastValue: T | null, unsubscribe: () => void) => void
interface SingleEvent<T> {
    (fn: HandlerCallback<T>): CancelCallback
}

interface SingleEventEmitter<T> {
    onSub(fn: SubscribeHandlerCallback<T>): CancelCallback
    unSubAll(): void
    emit(value: T): void
    event: SingleEvent<T>
}

const createEventEmitter = <T>(): SingleEventEmitter<T> => {
    const subscribeCallbacks: Set<SubscribeHandlerCallback<T>> = new Set()
    const handlerCallbacks: Set<HandlerCallback<T>> = new Set()
    let hasEmitted = false
    let lastValue: T | null = null

    const onSub: SingleEventEmitter<T>['onSub'] = (fn) => {
        if (subscribeCallbacks.has(fn)) {
            throw new Error('already subscribed')
        }

        subscribeCallbacks.add(fn)

        return () => {
            subscribeCallbacks.delete(fn)
        }
    }

    const unSubAll: SingleEventEmitter<T>['unSubAll'] = () => {
        const callbacks = [...handlerCallbacks]
        for (let cb of callbacks) {
            handlerCallbacks.delete(cb)
        }
    }

    const emit: SingleEventEmitter<T>['emit'] = (value: T) => {
        lastValue = value
        hasEmitted = true
        for (let cb of handlerCallbacks) {
            try {
                cb(value)
            } catch (err) {
                console.error(err)
            }
        }
    }

    const event: SingleEventEmitter<T>['event'] = (fn: HandlerCallback<T>) => {
        if (handlerCallbacks.has(fn)) {
            throw new Error('already subscribed')
        }

        handlerCallbacks.add(fn)

        const unSub = () => {
            handlerCallbacks.delete(fn)
        }

        for (const subCb of subscribeCallbacks) {
            try {
                subCb(fn, hasEmitted, lastValue, unSub)
            } catch (err) {
                console.error(err)
            }
        }

        return unSub
    }

    return {
        onSub,
        unSubAll,
        emit,
        event
    }
}

type DestroyEventEmitter = SingleEventEmitter<void>
type DestroyEvent = SingleEvent<void>

const createDestroyEventEmitter = (): DestroyEventEmitter => {
    const ev = createEventEmitter<void>()
    ev.onSub((fn, hasEmitted, lastValue, unSub) => {
        if (hasEmitted) {
            fn()
            unSub()
        }
    })
    ev.event(() => {
        Promise.resolve().then(() => {
            ev.unSubAll()
        })
    })
    return ev
}

export const createTaskQueue = <Result, Args extends any[] = []>(timeout: number, executer: (...args: [...Args, DestroyEventEmitter]) => Promise<Result>) => {
    type Defer = {
        getResolveFn: () => ((res: Result) => void)
        getRejectFn: () => ((reason: any) => void)
        setResolveFn: (fn: ((res: Result) => void)) => void
        setRejectFn: (fn: ((reason: any) => void)) => void
    }
    // whether there is active task running
    let timeoutId: null | ReturnType<typeof setTimeout> = null
    let resultPromise: null | Promise<Result> & Defer & { onDestroy: DestroyEvent, destroy: () => void } = null

    const resetTimeout = () => {
        if (timeoutId != null) {
            clearTimeout(timeoutId)
        }
        timeoutId = null
    }
    const reset = () => {
        resetTimeout()
        if (resultPromise != null) {
            resultPromise.destroy()
        }
        resultPromise = null
    }

    const queue = {
        isRequesting() {
            return timeoutId != null
        },
        request(...args: Args) {
            if (resultPromise != null) {
                // console.log('reture repeated request from previous')
                return resultPromise
            }

            let resolveFn: ((res: Result) => void) = null!
            let rejectFn: ((reason: any) => void) = null!

            const getResolveFn = () => {
                return resolveFn
            }

            const getRejectFn = () => {
                return rejectFn
            }

            const setResolveFn = (fn: ((res: Result) => void)) => {
                resolveFn = fn
            }
            const setRejectFn = (fn: ((reason: any) => void)) => {
                rejectFn = fn
            }

            const destroyEventEmitter = createDestroyEventEmitter()

            const racedExternalResult = new Promise<Result>((resolve, reject) => {
                resolveFn = resolve
                rejectFn = reject
            })

            const currentP = resultPromise = Object.assign(Promise.race([executer(...args, destroyEventEmitter), racedExternalResult]).then(
                (res) => {
                    clearTimeout(currentTimeoutId)
                    if (currentTimeoutId === timeoutId) {
                        timeoutId = null
                    }
                    return res
                },
                (err) => {
                    clearTimeout(currentTimeoutId)
                    if (currentTimeoutId === timeoutId) {
                        timeoutId = null
                    }
                    destroyEventEmitter.emit()
                    throw err
                }
            ), {
                getResolveFn,
                getRejectFn,
                setResolveFn,
                setRejectFn,
                onDestroy: destroyEventEmitter.event,
                destroy: () => destroyEventEmitter.emit()
            })

            const currentTimeoutId = timeoutId = setTimeout(() => {
                reset()
                getRejectFn()(new Error('timeout'))
            }, timeout)

            return currentP
        },
        externalResolve(res: Result) {
            if (resultPromise == null) {
                // we may get the result even before asked, but just keep it anyway
                const destroyEventEmitter = createDestroyEventEmitter()
                resultPromise = Object.assign(Promise.resolve(res), {
                    getResolveFn: () => () => { },
                    getRejectFn: () => () => { },
                    setResolveFn: () => { },
                    setRejectFn: () => { },
                    onDestroy: destroyEventEmitter.event,
                    destroy: () => destroyEventEmitter.emit()
                })
                return
            }
            resetTimeout()
            resultPromise.getResolveFn()(res)
        },
        externalReject(err: any) {
            if (resultPromise == null) {
                // we may get the deny even before asked, but just keep it anyway
                const destroyEventEmitter = createDestroyEventEmitter()
                // this can't be solved, it is destroyed before asking
                destroyEventEmitter.emit()
                resultPromise = Object.assign(Promise.reject(err), {
                    getResolveFn: () => () => { },
                    getRejectFn: () => () => { },
                    setResolveFn: () => { },
                    setRejectFn: () => { },
                    onDestroy: destroyEventEmitter.event,
                    destroy: () => destroyEventEmitter.emit()
                })
                return
            }
            resetTimeout()
            resultPromise.getRejectFn()(err)
        },
        reset() {
            reset()
        },
        unsafeReset() {
            // dust anything and don't even trigger callback even it supposed to
            resultPromise?.setResolveFn(() => { })
            resultPromise?.setRejectFn(() => { })
            reset()
        },
        get _current() {
            return resultPromise
        }
    }

    return queue
}