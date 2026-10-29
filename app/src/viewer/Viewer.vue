<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import HexView from './HexView.vue'
import { fileUrlFromHash, formatSize, looksLikeText, openRemoteFile, type RemoteFile } from './remote'

// Monaco is most of the download, files that are not text never need it
const TextView = defineAsyncComponent(() => import('./TextView.vue'))

/** enough to tell text from binary */
const SAMPLE_SIZE = 8192

type Mode = 'text' | 'hex'

const file = ref<RemoteFile | null>(null)
/** the start of the file, all of a small one */
const sample = shallowRef<Uint8Array>(new Uint8Array(0))
const mode = ref<Mode>('text')
const error = ref<string | null>(null)
/** known before the file opens, signing in there is how a password protected share opens */
const folderUrl = ref<string | null>(null)
/** remounts the views when the file is opened again */
const opened = ref(0)

async function open() {
  file.value = null
  error.value = null
  try {
    const url = fileUrlFromHash(location.hash)
    folderUrl.value = new URL('./', url).href
    const opening = await openRemoteFile(url, SAMPLE_SIZE)
    const remote = opening.file
    mode.value = looksLikeText(opening.sample, opening.sample.length === remote.size) ? 'text' : 'hex'
    sample.value = opening.sample
    file.value = remote
    opened.value++
    document.title = `${remote.name} · File viewer`
  } catch (err) {
    error.value = (err as Error).message
  }
}

const onError = (message: string) => {
  error.value = message
}

onMounted(() => {
  open()
  window.addEventListener('hashchange', open)
})
onUnmounted(() => window.removeEventListener('hashchange', open))
</script>

<template>
  <div class="viewer">
    <header class="topbar">
      <div class="title">
        <a v-if="folderUrl" :href="folderUrl" class="folder" title="Back to the folder">Folder</a>
        <h1>{{ file?.name ?? 'File viewer' }}</h1>
        <span v-if="file" class="size">{{ formatSize(file.size) }}</span>
      </div>
      <div v-if="file" class="actions">
        <div class="modes" role="group" aria-label="Show as">
          <button type="button" :aria-pressed="mode === 'text'" @click="mode = 'text'">Text</button>
          <button type="button" :aria-pressed="mode === 'hex'" @click="mode = 'hex'">Hex</button>
        </div>
        <a :href="file.url" target="_blank" rel="noopener noreferrer">Open the file</a>
      </div>
    </header>
    <p v-if="error" class="error" role="alert">
      {{ error }}
      <button v-if="file" type="button" class="link" @click="open">Reload</button>
    </p>
    <main v-if="file" class="content">
      <TextView v-if="mode === 'text'" :key="`text-${opened}`" :file="file" :sample="sample" @error="onError" />
      <HexView v-else :key="`hex-${opened}`" :file="file" @error="onError" />
    </main>
    <p v-else-if="!error" class="loading">Opening the file…</p>
  </div>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
}
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.title h1 {
  margin: 0;
  overflow: hidden;
  font-size: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder::after {
  content: ' /';
  color: var(--muted);
}
.size {
  flex: none;
  color: var(--muted);
  font-size: 13px;
}
a {
  color: var(--accent);
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}
.actions {
  display: flex;
  align-items: center;
  gap: 16px;
}
.modes {
  display: flex;
}
.modes button {
  padding: 3px 12px;
}
.modes button:first-child {
  border-radius: 6px 0 0 6px;
}
.modes button:last-child {
  margin-left: -1px;
  border-radius: 0 6px 6px 0;
}
.modes button[aria-pressed='true'] {
  border-color: var(--accent);
  background: var(--selected);
  position: relative;
}
.error {
  margin: 0;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--notice);
}
.loading {
  margin: 0;
  padding: 16px;
  color: var(--muted);
}
.content {
  flex: 1;
  min-height: 0;
  background: var(--panel);
}
</style>
