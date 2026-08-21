<script setup lang="ts">
import { computed, onMounted } from "vue";
import Modal from "../components/common/Modal.vue";
import GroupForm from "../components/contacts/GroupForm.vue";
import { useAppStore } from "../stores/app";
import { useConversationsStore } from "../stores/conversations";
import { useModelsStore } from "../stores/models";
import { t } from "../i18n";

const app = useAppStore();
const conversations = useConversationsStore();
const models = useModelsStore();

onMounted(() => {
  if (!models.loaded) void models.load();
});

const editing = computed(() => app.editingGroup);
const isNew = computed(() => editing.value === "new");
const title = computed(() => (isNew.value ? t("contacts.startGroup") : t("contacts.editGroup")));
const group = computed(() => {
  const e = editing.value;
  return e === "new" || e === null ? null : e;
});

async function onCreated(convId: string) {
  app.closeGroupEditor();
  app.navigate("chat");
  await conversations.select(convId);
}

function onSaved() {
  // 编辑保存后刷新成员缓存，保持详情页同步
  const id = group.value?.id;
  if (id) void conversations.loadMembers(id);
  app.closeGroupEditor();
}
</script>

<template>
  <Modal v-if="editing" :title="title" wide @close="app.closeGroupEditor()">
    <GroupForm
      :group="group"
      :preset-ids="isNew ? app.groupEditorPreset : null"
      @cancel="app.closeGroupEditor()"
      @created="onCreated"
      @saved="onSaved"
    />
  </Modal>
</template>
