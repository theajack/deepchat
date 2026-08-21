<script setup lang="ts">
import { computed, ref } from "vue";
import { Search, FolderOpen, Github, Plus } from "lucide-vue-next";
import Modal from "../common/Modal.vue";
import SkillSearchTab from "./SkillSearchTab.vue";
import SkillLocalTab from "./SkillLocalTab.vue";
import SkillGithubTab from "./SkillGithubTab.vue";
import SkillCreateTab from "./SkillCreateTab.vue";
import { t } from "../../i18n";

const emit = defineEmits<{ close: []; installed: [names: string[]] }>();

type Tab = "search" | "local" | "github" | "create";
const activeTab = ref<Tab>("search");

const tabs = computed<{ id: Tab; label: string; icon: any }[]>(() => [
  { id: "search", label: t("skills.tab.search"), icon: Search },
  { id: "local", label: t("skills.tab.local"), icon: FolderOpen },
  { id: "github", label: t("skills.tab.github"), icon: Github },
  { id: "create", label: t("skills.tab.create"), icon: Plus },
]);

function onInstalled(names: string[]) {
  emit("installed", names);
}
</script>

<template>
  <Modal :title="t('skills.add')" wide @close="emit('close')">
    <div class="flex flex-col gap-4">
      <!-- Tab 栏 -->
      <div class="flex gap-1 rounded-xl border border-line bg-ink-2/40 p-1">
        <button v-for="tab in tabs" :key="tab.id" @click="activeTab = tab.id"
          class="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium transition-all"
          :class="activeTab === tab.id
            ? 'bg-accent-soft text-accent'
            : 'text-mid hover:text-hi hover:bg-ink-3/50'">
          <component :is="tab.icon" :size="14" />
          {{ tab.label }}
        </button>
      </div>

      <!-- Tab 内容 -->
      <SkillSearchTab v-if="activeTab === 'search'" @installed="onInstalled" />
      <SkillLocalTab v-else-if="activeTab === 'local'" @installed="onInstalled" />
      <SkillGithubTab v-else-if="activeTab === 'github'" @installed="onInstalled" />
      <SkillCreateTab v-else-if="activeTab === 'create'" @installed="onInstalled" />
    </div>
  </Modal>
</template>
