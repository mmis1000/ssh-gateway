<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { takeCredentialFromHash, useConnection } from './connection'
import RequestDetail from './components/RequestDetail.vue'
import RequestList from './components/RequestList.vue'

const connection = useConnection()
const { status, publicUrl, notice, entries } = connection

const loginName = ref('')
const loginPassword = ref('')
const filter = ref('')
const selectedId = ref<number | null>(null)
/** entries up to this id are hidden by "Clear" */
const clearedBefore = ref(0)

const signedIn = computed(() => status.value === 'open' || status.value === 'reconnecting')

const visibleEntries = computed(() => {
  const query = filter.value.trim().toLowerCase()
  return entries.value
    .filter(entry => entry.id > clearedBefore.value)
    .filter(entry => !query || `${entry.method} ${entry.status ?? ''} ${entry.path}`.toLowerCase().includes(query))
    .reverse()
})

const selected = computed(() => entries.value.find(entry => entry.id === selectedId.value) ?? null)

// entry ids restart when the gateway restarts, history is replaced then
watch(entries, (list) => {
  if (list.length && clearedBefore.value > list[list.length - 1].id) clearedBefore.value = 0
})

const onLogin = () => {
  if (!loginName.value || !loginPassword.value) return
  connection.connect(loginName.value.trim(), loginPassword.value)
  loginPassword.value = ''
}

const onSignOut = () => {
  connection.disconnect()
  selectedId.value = null
  clearedBefore.value = 0
}

const onClear = () => {
  const last = entries.value[entries.value.length - 1]
  clearedBefore.value = last ? last.id : 0
  selectedId.value = null
}

const onHashChange = () => {
  const credential = takeCredentialFromHash()
  if (credential) connection.connect(credential.username, credential.password)
}

onMounted(() => {
  connection.resume()
  // a new link from run.sh opened while the inspector is already loaded
  window.addEventListener('hashchange', onHashChange)
})
onUnmounted(() => window.removeEventListener('hashchange', onHashChange))
</script>

<template>
  <main v-if="!signedIn" class="login">
    <form @submit.prevent="onLogin">
      <h1>Gateway inspector</h1>
      <p class="hint">
        Sign in with the id and password from your client. They are printed by <code>run.sh</code>
        after it registers, together with a direct inspector link.
      </p>
      <label>
        Id
        <input v-model="loginName" name="username" autocomplete="username" required>
      </label>
      <label>
        Password
        <input v-model="loginPassword" name="password" type="password" autocomplete="current-password" required>
      </label>
      <p v-if="status === 'auth-failed'" class="error">Wrong id or password.</p>
      <button type="submit" class="primary" :disabled="status === 'connecting'">
        {{ status === 'connecting' ? 'Connecting…' : 'Sign in' }}
      </button>
    </form>
  </main>

  <div v-else class="shell" :class="{ 'has-selection': selected }">
    <header class="topbar">
      <h1>Inspector</h1>
      <a v-if="publicUrl" class="public-url" :href="publicUrl" target="_blank" rel="noopener">{{ publicUrl }}</a>
      <span class="connection" :class="status">
        <span class="dot" />{{ status === 'open' ? 'Live' : 'Reconnecting…' }}
      </span>
      <span class="spacer" />
      <input v-model="filter" class="filter" type="search" placeholder="Filter method, status, path">
      <button type="button" @click="onClear">Clear</button>
      <button type="button" @click="onSignOut">Sign out</button>
    </header>

    <div v-if="notice" class="notice">
      {{ notice }}
      <button type="button" class="link" @click="notice = null">Dismiss</button>
    </div>

    <div class="panes">
      <RequestList class="list-pane" :entries="visibleEntries" :selected-id="selectedId" @select="selectedId = $event">
        <template #empty>
          <template v-if="filter">No requests match the filter.</template>
          <template v-else>
            No requests yet. Open
            <a v-if="publicUrl" :href="publicUrl" target="_blank" rel="noopener">{{ publicUrl }}</a>
            <template v-else>your forward</template>
            and they show up here.
          </template>
        </template>
      </RequestList>
      <RequestDetail
        v-if="selected"
        class="detail-pane"
        :entry="selected"
        :public-url="publicUrl"
        @close="selectedId = null"
        @replay="connection.replay($event)"
        @select="selectedId = $event"
      />
      <div v-else class="detail-pane placeholder">Select a request to see its details.</div>
    </div>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 16px;
}
.login form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: min(360px, 100%);
  padding: 28px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}
.login h1 {
  margin: 0;
  font-size: 20px;
}
.login label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.hint {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
.error {
  margin: 0;
  color: var(--error);
}
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.topbar h1 {
  margin: 0;
  font-size: 15px;
}
.public-url {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 12px;
}
.connection {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warn);
}
.connection.open .dot {
  background: var(--ok);
}
.spacer {
  flex: 1;
}
.filter {
  width: min(260px, 100%);
}
.notice {
  display: flex;
  gap: 12px;
  padding: 8px 16px;
  background: var(--notice);
  font-size: 13px;
}
.panes {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(360px, 2fr) 3fr;
  min-height: 0;
}
.list-pane {
  border-right: 1px solid var(--border);
}
.placeholder {
  display: grid;
  place-items: center;
  color: var(--muted);
}
@media (max-width: 900px) {
  .panes {
    grid-template-columns: 1fr;
  }
  .placeholder {
    display: none;
  }
  .has-selection .list-pane {
    display: none;
  }
}
</style>
