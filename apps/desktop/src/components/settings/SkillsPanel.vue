<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  BookOpen, Plus, RefreshCw, Trash2, ChevronDown,
  AlertTriangle, Package, Loader2, ExternalLink,
} from "lucide-vue-next";
import { agentApi, type SkillInfo } from "../../services/agentApi";
import AddSkillModal from "../skills/AddSkillModal.vue";
import ConfirmDialog from "../../utils/ConfirmDialog.vue";
import { t } from "../../i18n";

const skills = ref<SkillInfo[]>([]);
const loading = ref(false);
const error = ref("");
const expandedSkill = ref<string | null>(null);
const showAdd = ref(false);
const deletingName = ref("");
const confirmDialog = ref<InstanceType<typeof ConfirmDialog> | null>(null);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await agentApi.skillList();
    skills.value = res.skills;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    skills.value = [];
  } finally {
    loading.value = false;
  }
}

async function remove(name: string, builtin?: boolean) {
  if (builtin) return; // 内置技能不可删除
  const ok = await confirmDialog.value?.ask({
    title: t("skills.delete.title"),
    message: t("skills.delete.message", { name }),
    confirmText: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  deletingName.value = name;
  try {
    await agentApi.skillDelete(name);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    deletingName.value = "";
  }
}

function toggleExpand(name: string) {
  expandedSkill.value = expandedSkill.value === name ? null : name;
}

function onInstalled(_names: string[]) {
  // 安装/创建成功后刷新列表（弹窗保持打开，允许继续添加）
  load();
}

onMounted(load);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <!-- 首行：计数 + 添加/刷新按钮 -->
    <div class="flex items-center justify-between">
      <span class="text-[12px] text-lo">
        {{ t("skills.count", { count: skills.length }) }}
      </span>
      <div class="flex items-center gap-2">
        <button @click="showAdd = true"
          class="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-3 py-1.5 text-[12.5px] font-medium text-on-accent">
          <Plus :size="13" /> {{ t("common.add") }}
        </button>
        <button @click="load"
          class="inline-flex items-center gap-1 rounded-lg border border-line bg-ink-2 px-2.5 py-1.5 text-[12px] text-mid transition-colors hover:text-accent">
          <RefreshCw :size="13" :class="loading ? 'animate-spin' : ''" />
        </button>
      </div>
    </div>

    <div v-if="error" class="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[12px] text-danger">
      <AlertTriangle :size="13" class="shrink-0" />{{ error }}
    </div>

    <div v-if="loading && !skills.length" class="flex items-center justify-center gap-2 py-10 text-[12px] text-lo">
      <Loader2 :size="14" class="animate-spin" /> {{ t("common.loading") }}
    </div>

    <!-- 技能列表 -->
    <div v-else-if="skills.length" class="grid grid-cols-1 gap-2">
      <div v-for="s in skills" :key="s.name"
        class="min-w-0 rounded-xl border border-line bg-ink-3/40 transition-colors hover:border-line-strong">
        <div class="flex items-start gap-2.5 p-2.5">
          <BookOpen :size="14" class="mt-0.5 shrink-0 text-accent" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <a v-if="s.source" :href="`https://github.com/${s.source}`" target="_blank"
                class="inline-flex items-center gap-1 font-mono text-[12.5px] font-medium text-hi transition-colors hover:text-accent hover:underline">
                {{ s.name }}
                <ExternalLink :size="11" class="shrink-0 text-lo" />
              </a>
              <span v-else class="font-mono text-[12.5px] font-medium text-hi">{{ s.name }}</span>
              <span v-if="s.builtin"
                class="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">{{ t("common.builtin") }}</span>
              <span v-if="s.internal"
                class="rounded bg-info/15 px-1.5 py-0.5 text-[10px] text-info">{{ t("common.internal") }}</span>
              <span v-if="s.disableModelInvocation"
                class="rounded bg-ink-1 px-1.5 py-0.5 text-[10px] text-lo">{{ t("skills.manualOnly") }}</span>
            </div>
            <p class="mt-0.5 line-clamp-2 break-words text-[11.5px] leading-snug text-mid">{{ s.description }}</p>
            <p class="mt-1 truncate font-mono text-[10px] text-lo">{{ s.location }}</p>
          </div>
          <!-- 操作按钮 -->
          <div class="flex shrink-0 items-center gap-1">
            <button @click="toggleExpand(s.name)"
              class="rounded-md border border-line px-1.5 py-1 text-lo transition-colors hover:text-hi">
              <ChevronDown :size="12" class="transition-transform"
                :class="expandedSkill === s.name ? 'rotate-180' : ''" />
            </button>
            <button v-if="!s.builtin" @click="remove(s.name, s.builtin)" :disabled="deletingName === s.name"
              :title="t('common.delete')"
              class="rounded-md border border-red-500/30 px-1.5 py-1 text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50">
              <Loader2 v-if="deletingName === s.name" :size="12" class="animate-spin" />
              <Trash2 v-else :size="12" />
            </button>
          </div>
        </div>
        <!-- 展开正文 -->
        <div v-if="expandedSkill === s.name" class="border-t border-line px-3 py-2.5">
          <pre class="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-mid">{{ s.body }}</pre>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else-if="!loading" class="flex flex-col items-center gap-2 py-10 text-center">
      <Package :size="28" class="text-lo" />
      <p class="text-[12px] text-lo">{{ t("skills.empty") }}</p>
      <button @click="showAdd = true"
        class="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-3 py-1.5 text-[12px] font-medium text-on-accent">
        <Plus :size="13" /> {{ t("skills.add") }}
      </button>
    </div>

    <!-- 添加技能弹窗 -->
    <AddSkillModal v-if="showAdd" @close="showAdd = false" @installed="onInstalled" />
    <!-- 二次确认弹框（复用 ConfirmModal） -->
    <ConfirmDialog ref="confirmDialog" />
  </div>
</template>
