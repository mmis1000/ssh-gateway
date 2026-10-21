import { ref, shallowRef, triggerRef } from 'vue'
import type { ClientPacket, InspectorEntry, Packet } from './interface'

/** must match WS_AUTH_FAILED in src/http_server.ts */
const WS_AUTH_FAILED = 4001
const MAX_ENTRIES = 500
const CREDENTIAL_KEY = 'gateway-inspector-credential'

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'auth-failed'

interface Credential {
  username: string
  password: string
}

function loadCredential(): Credential | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CREDENTIAL_KEY) ?? 'null')
    if (parsed && typeof parsed.username === 'string' && typeof parsed.password === 'string') return parsed
  } catch (err) {}
  return null
}

function saveCredential(credential: Credential | null) {
  try {
    if (credential) sessionStorage.setItem(CREDENTIAL_KEY, JSON.stringify(credential))
    else sessionStorage.removeItem(CREDENTIAL_KEY)
  } catch (err) {}
}

/** the ssh client prints a link with #id:password, take it and remove it from the address bar */
export function takeCredentialFromHash(): Credential | null {
  const match = /^#([^:]+):(.+)$/.exec(location.hash)
  if (!match) return null
  history.replaceState(null, '', location.pathname + location.search)
  return { username: decodeURIComponent(match[1]), password: decodeURIComponent(match[2]) }
}

export function useConnection() {
  const status = ref<ConnectionStatus>('idle')
  const username = ref('')
  const publicUrl = ref('')
  const notice = ref<string | null>(null)
  const entries = shallowRef<InspectorEntry[]>([])

  let ws: WebSocket | null = null
  let credential: Credential | null = null
  let retry = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const upsert = (entry: InspectorEntry) => {
    const list = entries.value
    const index = list.findIndex(item => item.id === entry.id)
    if (index >= 0) {
      list[index] = entry
    } else {
      list.push(entry)
      if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
    }
    triggerRef(entries)
  }

  const onPacket = (packet: Packet) => {
    switch (packet.type) {
      case 'authenticated':
        status.value = 'open'
        publicUrl.value = packet.url
        retry = 0
        saveCredential(credential)
        break
      case 'history':
        entries.value = packet.entries.slice(-MAX_ENTRIES)
        break
      case 'entry':
        upsert(packet.entry)
        break
      case 'replay-failed':
        notice.value = `Replay failed: ${packet.message}`
        break
    }
  }

  const open = () => {
    if (!credential) return
    const current = credential
    const socket = ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__observe_requests`)

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify([current.username, current.password]))
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        onPacket(JSON.parse(event.data))
      } catch (err) {
        console.error(err)
      }
    })
    socket.addEventListener('close', (event) => {
      if (ws !== socket) return
      ws = null

      if (event.code === WS_AUTH_FAILED) {
        status.value = 'auth-failed'
        credential = null
        saveCredential(null)
        return
      }

      status.value = 'reconnecting'
      const delay = Math.min(1000 * 2 ** retry, 15000)
      retry++
      retryTimer = setTimeout(open, delay)
    })
  }

  const connect = (name: string, password: string) => {
    disconnect()
    credential = { username: name, password }
    username.value = name
    notice.value = null
    status.value = 'connecting'
    open()
  }

  const disconnect = () => {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    retry = 0
    const socket = ws
    ws = null
    socket?.close()
    credential = null
    saveCredential(null)
    status.value = 'idle'
    entries.value = []
    publicUrl.value = ''
  }

  const send = (packet: ClientPacket) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(packet))
  }

  const replay = (id: number) => send({ type: 'replay', id })

  const resume = () => {
    const saved = takeCredentialFromHash() ?? loadCredential()
    if (saved) connect(saved.username, saved.password)
  }

  return { status, username, publicUrl, notice, entries, connect, disconnect, replay, resume }
}
