<template>
  <div class="request-list" tabindex="0" @keydown="onKeydown">
    <div class="row head">
      <span class="time">Time</span>
      <span class="method">Method</span>
      <span class="status">Status</span>
      <span class="path">Path</span>
      <span class="duration">Duration</span>
      <span class="size">Size</span>
    </div>
    <div v-if="entries.length === 0" class="empty">
      <slot name="empty" />
    </div>
    <button
      v-for="entry of entries"
      :key="entry.id"
      type="button"
      class="row"
      :class="{ selected: entry.id === selectedId }"
      :data-id="entry.id"
      @click="emit('select', entry.id)"
    >
      <span class="time">{{ formatTime(entry.startTime) }}</span>
      <span class="method">{{ entry.method }}</span>
      <span class="status"><span class="badge" :class="statusClass(entry)">{{ statusText(entry) }}</span></span>
      <span class="path" :title="entry.path">
        <span v-if="entry.replayOf !== null" class="replay-mark" title="Replayed request">↻</span>{{ entry.path }}
      </span>
      <span class="duration">{{ formatDuration(entry.duration) }}</span>
      <span class="size">{{ entry.responseBody ? formatBytes(entry.responseBody.size) : '' }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { InspectorEntry } from '../interface'
import { formatBytes, formatDuration, formatTime, statusClass, statusText } from '../format'

const props = defineProps<{
  entries: InspectorEntry[]
  selectedId: number | null
}>()

const emit = defineEmits<{
  select: [id: number]
}>()

const onKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const index = props.entries.findIndex(entry => entry.id === props.selectedId)
  const next = event.key === 'ArrowDown'
    ? Math.min(index + 1, props.entries.length - 1)
    : Math.max(index - 1, 0)
  const entry = props.entries[next]
  if (!entry) return
  emit('select', entry.id)
  ;(event.currentTarget as HTMLElement).querySelector(`[data-id="${entry.id}"]`)?.scrollIntoView({ block: 'nearest' })
}
</script>

<style scoped>
.request-list {
  overflow: auto;
  outline: none;
  font-size: 13px;
}
.row {
  display: grid;
  grid-template-columns: 7.5em 4.5em 4em minmax(0, 1fr) 4.5em 4.5em;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 6px 12px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.row:hover {
  background: var(--hover);
}
.row.selected {
  background: var(--selected);
}
.row.head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--panel);
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: default;
}
.time,
.duration,
.size {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.duration,
.size {
  text-align: right;
}
.method {
  font-weight: 600;
}
.path {
  overflow: hidden;
  font-family: var(--mono);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.replay-mark {
  margin-right: 4px;
  color: var(--accent);
}
.empty {
  padding: 32px 16px;
  color: var(--muted);
  text-align: center;
}
@media (max-width: 640px) {
  .row {
    grid-template-columns: 4.2em 4em minmax(0, 1fr) 5em;
    padding: 6px 10px;
  }
  .time,
  .size {
    display: none;
  }
}
</style>
