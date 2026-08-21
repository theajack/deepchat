<script setup lang="ts">
// ConfirmDialog — 封装 ConfirmModal + 状态管理。
// 使用方式：
//   <ConfirmDialog ref="confirmDialog" />
//   const ok = await confirmDialog.value?.ask({
//     title: "删除技能",
//     message: `确认删除「${name}」？`,
//     confirmText: "删除",
//     danger: true,
//   });
//   if (ok) { ... }

import { ref } from "vue";
import ConfirmModal from "../components/common/ConfirmModal.vue";

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

const state = ref<ConfirmState | null>(null);

function ask(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    state.value = { ...options, resolve };
  });
}

function onConfirm() {
  state.value?.resolve(true);
  state.value = null;
}

function onClose() {
  state.value?.resolve(false);
  state.value = null;
}

defineExpose({ ask });
</script>

<template>
  <ConfirmModal
    v-if="state"
    :title="state.title"
    :message="state.message"
    :confirm-text="state.confirmText"
    :cancel-text="state.cancelText"
    :danger="state.danger"
    @confirm="onConfirm"
    @close="onClose"
  />
</template>
