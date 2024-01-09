<script setup lang="ts">
import {ref} from 'vue'
const username =ref('')
const password = ref('')
const opened = ref(false)
const hasConnected = ref(false)
const onConnect = () => {
  hasConnected.value = true
  const ws = new WebSocket('wss://' + location.host + '/__observe_requests')
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify([
      username.value,
      password.value
    ]))
  })
  ws.addEventListener('message', (msg: MessageEvent) => {
    const data = msg.data
    // @ts-ignore
    const parsed: import('../../src/interface.ts').Packet = JSON.parse(data)
    if (parsed.type === 'authenticated') {
      opened.value = true
    }
    if (parsed.type === 'request-header') {
      packets.value.push({
        id: parsed.id,
        method: parsed.method,
        path: parsed.path,
        code: -1,
        req: parsed.headers,
        res: {}
      })
    }
    if (parsed.type === 'response-header') {
      const target = packets.value.find(i => i.id === parsed.id)
      if (target) {
        target.code = parsed.code
        target.res = parsed.headers
      }
    }
  })
  ws.addEventListener('close', () => {
    opened.value = false
    if (hasConnected.value) {
      console.log('trying to reconnect')
      onConnect()
    }
  })
}
const packets = ref<{
  id: number,
  method: string,
  path: string,
  code: number,
  req: Record<string, string | string[] | undefined>,
  res: Record<string, string | string[] | undefined>,
}[]>([])
</script>

<template>
  <div v-if="!opened">
    <input name="username" type="text" v-model="username">
    <input name="password" type="text" v-model="password">
    <button @click="onConnect">Connect</button>
  </div>
  <div v-else>
    <div v-for="packet of packets" :key="packet.id">
      #{{ packet.id }} <br>
      method: {{ packet.method }} <br>
      url: {{ packet.path }} <br>
      code: {{ packet.code }} <br>
      req: <pre>{{ JSON.stringify(packet.req, undefined, 4) }}</pre>
      res: <pre>{{ JSON.stringify(packet.res, undefined, 4) }}</pre>
    </div>
  </div>
</template>

<style scoped>
.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}
.logo:hover {
  filter: drop-shadow(0 0 2em #646cffaa);
}
.logo.vue:hover {
  filter: drop-shadow(0 0 2em #42b883aa);
}
</style>
