<template>
  <p v-if="view.kind === 'empty'" class="note">No body</p>
  <template v-else>
    <div class="meta">
      <span>{{ formatBytes(body!.size) }}</span>
      <span v-if="view.mime">{{ view.mime }}</span>
      <span v-if="body!.encoding">{{ body!.decoded ? `decoded from ${body!.encoding}` : `${body!.encoding} (not decoded)` }}</span>
      <span v-if="body!.truncated" class="warn">showing first {{ formatBytes(view.bytes.length) }}</span>
      <span class="spacer" />
      <label v-if="canPretty" class="toggle"><input v-model="raw" type="checkbox"> Raw</label>
    </div>

    <p v-if="view.kind === 'encoded'" class="note">
      The body uses an encoding the inspector cannot decode. Raw bytes:
    </p>
    <img v-if="view.kind === 'image'" class="image" :src="imageUrl" alt="Response image">
    <table v-else-if="view.kind === 'form' && !raw" class="form">
      <tr v-for="([key, value], index) of formRows" :key="index">
        <th>{{ key }}</th>
        <td>{{ value }}</td>
      </tr>
    </table>
    <pre v-else-if="view.kind === 'json' && !raw">{{ prettyJson(view.text) }}</pre>
    <pre v-else-if="view.kind === 'binary' || view.kind === 'encoded'">{{ hexDump(view.bytes) }}</pre>
    <pre v-else>{{ view.text }}</pre>
  </template>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CapturedBody } from '../interface'
import { formatBytes, hexDump, prettyJson, viewBody } from '../format'

const props = defineProps<{
  body: CapturedBody | null
  contentType: string
}>()

const raw = ref(false)
const view = computed(() => viewBody(props.body, props.contentType))
const canPretty = computed(() => view.value.kind === 'json' || view.value.kind === 'form')
const imageUrl = computed(() => props.body ? `data:${view.value.mime};base64,${props.body.data}` : '')
const formRows = computed(() => [...new URLSearchParams(view.value.text)])
</script>

<style scoped>
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.warn {
  color: var(--warn);
}
.toggle {
  cursor: pointer;
}
.note {
  margin: 0 0 8px;
  color: var(--muted);
}
pre {
  max-height: 60vh;
  margin: 0;
  padding: 10px;
  overflow: auto;
  border-radius: 6px;
  background: var(--code);
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
.image {
  max-width: 100%;
  max-height: 60vh;
  border-radius: 6px;
  background: repeating-conic-gradient(var(--code) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
}
.form {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 12px;
}
.form th,
.form td {
  padding: 3px 0;
  vertical-align: top;
  text-align: left;
  word-break: break-all;
}
.form th {
  width: 30%;
  padding-right: 12px;
  color: var(--muted);
  font-weight: normal;
}
@media (max-width: 640px) {
  tr {
    display: flex;
    flex-direction: column;
    padding: 3px 0;
  }
  th,
  td {
    width: auto;
    padding: 0;
  }
}
</style>
