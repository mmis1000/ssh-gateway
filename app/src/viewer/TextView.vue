<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { monaco } from './monaco'
import { formatSize, readRange, type RemoteFile } from './remote'

const props = defineProps<{ file: RemoteFile, sample: Uint8Array }>()
const emit = defineEmits<{ (event: 'error', message: string): void }>()

/** more goes through the tunnel slowly and makes the editor sluggish, the hex view shows all of it */
const TEXT_LIMIT = 10 * 1024 * 1024

const container = ref<HTMLElement | null>(null)
const loading = ref(true)
const truncated = props.file.size > TEXT_LIMIT
const language = ref('plaintext')
const languages = monaco.languages.getLanguages()
  .map(entry => ({ id: entry.id, name: entry.aliases?.[0] ?? entry.id }))
  .sort((a, b) => a.name.localeCompare(b.name))

let editor: monaco.editor.IStandaloneCodeEditor | null = null
let model: monaco.editor.ITextModel | null = null
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')
const theme = () => (darkScheme.matches ? 'vs-dark' : 'vs')
const onSchemeChange = () => monaco.editor.setTheme(theme())

const onLanguageChange = () => {
  if (model) monaco.editor.setModelLanguage(model, language.value)
}

onMounted(async () => {
  darkScheme.addEventListener('change', onSchemeChange)
  let text: string
  try {
    // a small file came whole with the sample
    const bytes = props.sample.length === props.file.size
      ? props.sample
      : await readRange(props.file, 0, Math.min(props.file.size, TEXT_LIMIT))
    // streaming leaves out a character the limit cut in half
    text = new TextDecoder().decode(bytes, { stream: truncated })
  } catch (err) {
    emit('error', (err as Error).message)
    return
  } finally {
    loading.value = false
  }
  if (!container.value) return

  // without a language, the model picks one from the file name or the first line
  model = monaco.editor.createModel(text, undefined, monaco.Uri.parse(props.file.url))
  language.value = model.getLanguageId()
  editor = monaco.editor.create(container.value, {
    model,
    theme: theme(),
    readOnly: true,
    domReadOnly: true,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    fontSize: 13,
  })
})

onUnmounted(() => {
  darkScheme.removeEventListener('change', onSchemeChange)
  editor?.dispose()
  model?.dispose()
})
</script>

<template>
  <div class="text-view">
    <div class="bar">
      <p v-if="truncated" class="notice">
        Showing the first {{ formatSize(TEXT_LIMIT) }} of {{ formatSize(file.size) }}. The hex view shows all of it.
      </p>
      <span class="spacer" />
      <label>
        Language
        <select v-model="language" :disabled="loading" @change="onLanguageChange">
          <option v-for="entry in languages" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
        </select>
      </label>
    </div>
    <p v-if="loading" class="loading">Loading…</p>
    <div ref="container" class="editor" />
  </div>
</template>

<style scoped>
.text-view {
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
.notice {
  margin: 0;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--notice);
  color: var(--text);
}
.spacer {
  flex: 1;
}
select {
  margin-left: 6px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: inherit;
  font: inherit;
}
.loading {
  margin: 0;
  padding: 16px;
  color: var(--muted);
}
.editor {
  flex: 1;
  min-height: 0;
}
</style>
