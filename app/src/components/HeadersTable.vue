<template>
  <p v-if="rows.length === 0" class="none">No headers</p>
  <table v-else class="headers">
    <tr v-for="([key, value], index) of rows" :key="index">
      <th>{{ key }}</th>
      <td>{{ value }}</td>
    </tr>
  </table>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Headers } from '../interface'
import { headerList } from '../format'

const props = defineProps<{
  headers: Headers | null
}>()

const rows = computed(() => headerList(props.headers))
</script>

<style scoped>
.headers {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 12px;
}
th,
td {
  padding: 3px 0;
  vertical-align: top;
  text-align: left;
  word-break: break-all;
}
th {
  width: 30%;
  padding-right: 12px;
  color: var(--muted);
  font-weight: normal;
}
.none {
  margin: 0;
  color: var(--muted);
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
