<template>
  <div class="detail">
    <header class="summary">
      <button type="button" class="back" @click="emit('close')">← Back</button>
      <h2>
        <span class="method">{{ entry.method }}</span>
        <span class="path">{{ entry.path }}</span>
      </h2>
      <div class="facts">
        <span class="badge" :class="statusClass(entry)">{{ statusText(entry) }}</span>
        <span v-if="entry.state === 'aborted'" class="warn">connection closed before the response finished</span>
        <span>{{ formatDuration(entry.duration) }}</span>
        <span>{{ new Date(entry.startTime).toLocaleString() }}</span>
        <span>from {{ entry.remoteAddress || 'unknown' }}</span>
        <a v-if="entry.replayOf !== null" href="#" @click.prevent="emit('select', entry.replayOf)">replay of #{{ entry.replayOf }}</a>
      </div>
      <div class="actions">
        <button type="button" :disabled="!replayable" :title="replayable ? '' : replayBlocker" @click="emit('replay', entry.id)">Replay</button>
        <button type="button" @click="copyCurl">{{ copied ? 'Copied' : 'Copy as curl' }}</button>
      </div>
    </header>

    <section>
      <h3>Request headers</h3>
      <HeadersTable :headers="entry.requestHeaders" />
    </section>
    <section v-if="entry.requestBody && entry.requestBody.size > 0">
      <h3>Request body</h3>
      <BodyPanel :body="entry.requestBody" :content-type="headerValue(entry.requestHeaders, 'content-type')" />
    </section>

    <template v-if="entry.responseHeaders">
      <section>
        <h3>Response headers</h3>
        <HeadersTable :headers="entry.responseHeaders" />
      </section>
      <section>
        <h3>Response body</h3>
        <BodyPanel :body="entry.responseBody" :content-type="headerValue(entry.responseHeaders, 'content-type')" />
      </section>
    </template>
    <section v-else-if="entry.state === 'pending'">
      <p class="muted">Waiting for response…</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { InspectorEntry } from '../interface'
import { formatDuration, headerValue, statusClass, statusText, toCurl } from '../format'
import BodyPanel from './BodyPanel.vue'
import HeadersTable from './HeadersTable.vue'

const props = defineProps<{
  entry: InspectorEntry
  publicUrl: string
}>()

const emit = defineEmits<{
  close: []
  replay: [id: number]
  select: [id: number]
}>()

const replayBlocker = computed(() => {
  const body = props.entry.requestBody
  if (props.entry.state === 'pending') return 'Request still in progress'
  if (body?.truncated) return 'Request body too large to replay'
  if (body && !body.decoded) return 'Request body encoding not supported'
  return ''
})
const replayable = computed(() => replayBlocker.value === '')

const copied = ref(false)
watch(() => props.entry.id, () => { copied.value = false })

const copyCurl = async () => {
  try {
    await navigator.clipboard.writeText(toCurl(props.entry, props.publicUrl))
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch (err) {
    window.prompt('Copy the command', toCurl(props.entry, props.publicUrl))
  }
}
</script>

<style scoped>
.detail {
  overflow: auto;
  padding: 16px 20px 32px;
}
.summary {
  margin-bottom: 8px;
}
h2 {
  display: flex;
  gap: 10px;
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
}
.path {
  font-family: var(--mono);
  font-weight: normal;
  word-break: break-all;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px;
  color: var(--muted);
  font-size: 12px;
}
.facts a {
  color: var(--accent);
}
.warn {
  color: var(--warn);
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
section {
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
h3 {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.muted {
  margin: 0;
  color: var(--muted);
}
.back {
  display: none;
  margin-bottom: 10px;
}
@media (max-width: 900px) {
  .back {
    display: inline-block;
  }
}
</style>
