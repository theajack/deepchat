<script setup lang="ts">
import { onMounted, ref } from "vue";
import ModelList from "./ModelList.vue";
import ModelEditorModal from "./ModelEditorModal.vue";
import { useModelsStore } from "../../stores/models";

const models = useModelsStore();

const showEditor = ref(false);
const editingId = ref<string | null>(null);

onMounted(() => {
  if (!models.loaded) models.load();
});

function openAdd() {
  editingId.value = null;
  showEditor.value = true;
}

function openEdit(id: string) {
  editingId.value = id;
  showEditor.value = true;
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <ModelList :editing-id="editingId" @add="openAdd" @edit="openEdit" />
    <ModelEditorModal
      v-if="showEditor"
      :editing-id="editingId"
      @close="showEditor = false"
    />
  </div>
</template>
