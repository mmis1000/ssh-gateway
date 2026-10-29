<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { readRange, type RemoteFile } from './remote'

const props = defineProps<{ file: RemoteFile }>()
const emit = defineEmits<{ (event: 'error', message: string): void }>()

const BYTES_PER_ROW = 16
/** keep in sync with .row in the styles */
const ROW_HEIGHT = 20
/** bytes per range request, each one is a round trip through the tunnel */
const CHUNK_SIZE = 64 * 1024
/** chunks kept in memory, the ones furthest from the view are dropped first */
const MAX_CHUNKS = 64
/** browsers cap element heights, a larger file moves the scrollbar thumb by more than a row */
const MAX_TRACK_HEIGHT = 1_000_000

const size = props.file.size
const totalRows = Math.ceil(size / BYTES_PER_ROW)
const offsetDigits = Math.max(8, (Math.max(size, 1) - 1).toString(16).length)

const viewport = ref<HTMLElement | null>(null)
const track = ref<HTMLElement | null>(null)
/** rows that fit fully, one more is shown cut off */
const fullRows = ref(1)
const top = ref(0)
const selected = ref<number | null>(null)
const goTo = ref('')

const chunks = new Map<number, Uint8Array>()
const pending = new Set<number>()
/** bumped when a chunk arrives, chunks itself is not reactive */
const loaded = shallowRef(0)
let failed = false

const maxTop = computed(() => Math.max(0, totalRows - fullRows.value))
const trackHeight = Math.min(totalRows * ROW_HEIGHT, MAX_TRACK_HEIGHT)

const hex = (value: number, digits: number) => value.toString(16).padStart(digits, '0')
const printable = (byte: number) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')

function byteAt(offset: number) {
  return chunks.get(Math.floor(offset / CHUNK_SIZE))?.[offset % CHUNK_SIZE]
}

const rows = computed(() => {
  void loaded.value
  const result = []
  const last = Math.min(totalRows, top.value + fullRows.value + 1)
  for (let row = top.value; row < last; row++) {
    const offset = row * BYTES_PER_ROW
    const cells = []
    for (let index = offset; index < Math.min(offset + BYTES_PER_ROW, size); index++) {
      const byte = byteAt(index)
      cells.push({
        index,
        hex: byte === undefined ? '··' : hex(byte, 2),
        char: byte === undefined ? '·' : printable(byte),
      })
    }
    result.push({ offset, label: hex(offset, offsetDigits), cells })
  }
  return result
})

const selectedText = computed(() => {
  void loaded.value
  if (selected.value === null) return ''
  const byte = byteAt(selected.value)
  const offset = `Offset 0x${hex(selected.value, offsetDigits)} (${selected.value.toLocaleString()})`
  return byte === undefined ? offset : `${offset}, value 0x${hex(byte, 2)} (${byte})`
})

function load(chunk: number) {
  if (failed || chunks.has(chunk) || pending.has(chunk) || chunk * CHUNK_SIZE >= size) return
  pending.add(chunk)
  readRange(props.file, chunk * CHUNK_SIZE, Math.min(size, (chunk + 1) * CHUNK_SIZE))
    .then((bytes) => {
      chunks.set(chunk, bytes)
      const current = Math.floor((top.value * BYTES_PER_ROW) / CHUNK_SIZE)
      while (chunks.size > MAX_CHUNKS) {
        const furthest = [...chunks.keys()].reduce((a, b) => (Math.abs(b - current) > Math.abs(a - current) ? b : a))
        chunks.delete(furthest)
      }
      loaded.value++
    })
    .catch((err: Error) => {
      failed = true
      emit('error', err.message)
    })
    .finally(() => pending.delete(chunk))
}

// the chunks on screen, then the next one, as scrolling down is the most common
watch([top, fullRows], () => {
  const first = Math.floor((top.value * BYTES_PER_ROW) / CHUNK_SIZE)
  const last = Math.floor(((top.value + fullRows.value + 1) * BYTES_PER_ROW - 1) / CHUNK_SIZE)
  for (let chunk = first; chunk <= last + 1; chunk++) load(chunk)
}, { immediate: true })

function scrollTo(row: number) {
  top.value = Math.max(0, Math.min(maxTop.value, Math.round(row)))
}

/** the scroll position the scrollbar was last moved to by scrollTo, its own scroll event is skipped */
let syncedTrackTop = -1
watch([top, maxTop], () => {
  const element = track.value
  if (!element) return
  const range = element.scrollHeight - element.clientHeight
  syncedTrackTop = maxTop.value ? Math.round((top.value / maxTop.value) * range) : 0
  element.scrollTop = syncedTrackTop
}, { flush: 'post' })

const onTrackScroll = () => {
  const element = track.value!
  if (Math.abs(element.scrollTop - syncedTrackTop) < 1) return
  const range = element.scrollHeight - element.clientHeight
  syncedTrackTop = element.scrollTop
  if (range > 0) scrollTo((element.scrollTop / range) * maxTop.value)
}

/** pixels scrolled but not yet a whole row */
let leftover = 0
function scrollBy(pixels: number) {
  leftover += pixels
  const rowsMoved = Math.trunc(leftover / ROW_HEIGHT)
  leftover -= rowsMoved * ROW_HEIGHT
  if (rowsMoved) scrollTo(top.value + rowsMoved)
}

const onWheel = (event: WheelEvent) => {
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? ROW_HEIGHT
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? fullRows.value * ROW_HEIGHT : 1
  scrollBy(event.deltaY * unit)
}

let touchY: number | null = null
const onTouchStart = (event: TouchEvent) => {
  touchY = event.touches[0].clientY
}
const onTouchMove = (event: TouchEvent) => {
  if (touchY === null) return
  const y = event.touches[0].clientY
  scrollBy(touchY - y)
  touchY = y
}

const onKeyDown = (event: KeyboardEvent) => {
  const moves: Record<string, number> = {
    ArrowDown: 1,
    ArrowUp: -1,
    PageDown: fullRows.value,
    PageUp: -fullRows.value,
    Home: -Infinity,
    End: Infinity,
  }
  const move = moves[event.key]
  if (move === undefined) return
  event.preventDefault()
  scrollTo(Number.isFinite(move) ? top.value + move : move > 0 ? maxTop.value : 0)
}

/** 0x1f00 is hex, 7936 decimal */
const onGoTo = () => {
  const text = goTo.value.trim().replace(/_/g, '')
  const offset = /^0x[0-9a-f]+$/i.test(text) ? parseInt(text.slice(2), 16) : /^\d+$/.test(text) ? Number(text) : NaN
  if (!Number.isSafeInteger(offset) || offset >= size) return
  selected.value = offset
  scrollTo(Math.floor(offset / BYTES_PER_ROW) - 2)
}

let observer: ResizeObserver | null = null
onMounted(() => {
  observer = new ResizeObserver(() => {
    fullRows.value = Math.max(1, Math.floor(viewport.value!.clientHeight / ROW_HEIGHT))
    scrollTo(top.value)
  })
  observer.observe(viewport.value!)
})
onUnmounted(() => observer?.disconnect())
</script>

<template>
  <div class="hex-view">
    <form class="bar" @submit.prevent="onGoTo">
      <span class="selection">{{ selectedText || `${size.toLocaleString()} bytes, click a byte to see its offset` }}</span>
      <span class="spacer" />
      <label>
        Go to offset
        <input v-model="goTo" placeholder="0x1f00 or 7936" spellcheck="false" autocomplete="off">
      </label>
    </form>
    <p v-if="size === 0" class="empty">This file is empty.</p>
    <div
      v-else
      class="body"
      tabindex="0"
      @wheel.prevent="onWheel"
      @keydown="onKeyDown"
      @touchstart="onTouchStart"
      @touchmove.prevent="onTouchMove"
      @touchend="touchY = null"
    >
      <div ref="viewport" class="viewport">
        <div class="rows">
          <div v-for="row in rows" :key="row.offset" class="row">
            <span class="offset">{{ row.label }}</span>
            <span class="bytes">
              <span
                v-for="cell in row.cells"
                :key="cell.index"
                class="byte"
                :class="{ selected: cell.index === selected, pending: cell.hex === '··' }"
                @click="selected = cell.index"
              >{{ cell.hex }}</span>
            </span>
            <span class="chars">
              <span
                v-for="cell in row.cells"
                :key="cell.index"
                :class="{ selected: cell.index === selected, pending: cell.char === '·' }"
                @click="selected = cell.index"
              >{{ cell.char }}</span>
            </span>
          </div>
        </div>
      </div>
      <div ref="track" class="track" aria-hidden="true" @scroll="onTrackScroll">
        <div class="spacer-row" :style="{ height: `${trackHeight}px` }" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.hex-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 13px;
}
.selection {
  font-variant-numeric: tabular-nums;
}
.spacer {
  flex: 1;
}
.bar input {
  width: 150px;
  margin-left: 6px;
  padding: 3px 8px;
  font-family: var(--mono);
}
.empty {
  margin: 0;
  padding: 16px;
  color: var(--muted);
}
.body {
  display: flex;
  flex: 1;
  min-height: 0;
  background: var(--panel);
  outline: none;
}
.viewport {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  /* vertical moves are scrollTo, sideways the narrow screen scrolls itself */
  touch-action: pan-x;
}
.rows {
  width: max-content;
  padding: 0 16px;
  font: 13px/20px var(--mono);
  white-space: pre;
}
.row {
  display: flex;
  gap: 20px;
  height: 20px;
}
.offset {
  color: var(--muted);
  user-select: none;
}
.bytes {
  display: grid;
  /* an empty column between the two halves of a row */
  grid-template-columns: repeat(8, 2ch) 0 repeat(8, 2ch);
  column-gap: 1ch;
}
.byte:nth-child(9) {
  grid-column-start: 10;
}
.chars {
  display: grid;
  grid-template-columns: repeat(16, 1ch);
}
.selected {
  border-radius: 2px;
  background: var(--accent);
  color: #fff;
}
.pending {
  color: var(--muted);
}
.bytes span,
.chars span {
  cursor: default;
}
.track {
  /* as wide as the browser's own scrollbar, which is all it shows */
  flex: none;
  overflow-x: hidden;
  overflow-y: scroll;
  border-left: 1px solid var(--border);
}
.spacer-row {
  width: 1px;
}
</style>
