<template>
  <div class="info-row" @click="expanded = !expanded">
    #{{ props.data.id }}
    {{ props.data.method }}
    {{ props.data.code }}
    {{ props.data.path }}
    <div class="detail" :class="{ expanded: expanded }">
      <div>Req header</div>
      <pre>{{ JSON.stringify(props.data.req, undefined, 4) }}</pre>
      <div>Res header</div>
      <pre>{{ JSON.stringify(props.data.res, undefined, 4) }}</pre>
    </div>
  </div>
</template>
<script setup lang="ts">
import { PropType, ref } from 'vue';
import { DataRow } from '../interface';

const props = defineProps({
  data: {
    type: Object as PropType<DataRow>,
    required: true
  }
})

const expanded = ref(false)



</script>
<style scoped>
.info-row {
  min-height: 2em;
  line-height: 2em;
  border-bottom: 1px solid #aaa;
  word-break: break-all;
}
.detail {
  overflow: hidden;
  height: 0;
  line-height: 1.3em;
}

.detail.expanded{
  height: auto;
}
</style>