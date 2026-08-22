<script setup lang="ts">
import { ref } from "vue";
import {
  Search, AlertTriangle, Package, Loader2, Download, Check, ExternalLink,
} from "lucide-vue-next";
import { agentApi, type SkillSearchResult } from "../../services/agentApi";
import { t } from "../../i18n";

const emit = defineEmits<{ installed: [names: string[]] }>();

const searchQuery = ref("");
const searchOwner = ref("");
const searchResults = ref<SkillSearchResult[]>([]);
const searching = ref(false);
const searchError = ref("");
const searched = ref(false);

// 已安装的 source 集合（直接从后端拉取，避免父组件响应链问题）
const installedSourceSet = ref<Set<string>>(new Set());

async function refreshInstalledSources() {
  try {
    const res = await agentApi.skillList();
    installedSourceSet.value = new Set(
      res.skills.map((s) => s.source).filter((v): v is string => !!v),
    );
  } catch {
    // 静默失败 — 不阻塞搜索
  }
}

// 本会话内刚安装的 slug 集合
const locallyInstalledSlugs = ref<Set<string>>(new Set());
const installingSlug = ref<string | null>(null);
const installError = ref<Record<string, string>>({});

function isInstalled(s: SkillSearchResult): boolean {
  return installedSourceSet.value.has(s.source) || locallyInstalledSlugs.value.has(s.slug);
}

async function search() {
  if (!searchQuery.value.trim()) {
    searchError.value = t("skills.search.enterKeyword");
    return;
  }
  searching.value = true;
  searchError.value = "";
  searched.value = true;
  // 搜索前拉取最新已安装列表
  await refreshInstalledSources();
  try {
    const res = await agentApi.skillFind(
      searchQuery.value.trim(),
      searchOwner.value.trim() || undefined,
    );
    searchResults.value = res.skills;
  } catch (e) {
    searchError.value = e instanceof Error ? e.message : String(e);
    searchResults.value = [];
  } finally {
    searching.value = false;
  }
}

async function install(s: SkillSearchResult) {
  installingSlug.value = s.slug;
  installError.value[s.slug] = "";
  try {
    const res = await agentApi.skillInstallGithub(`${s.source || s.slug}@${s.name}`);
    locallyInstalledSlugs.value.add(s.slug);
    // 安装后立即刷新已安装 source 集合
    await refreshInstalledSources();
    if (res.installed.length) emit("installed", res.installed);
  } catch (e) {
    installError.value[s.slug] = e instanceof Error ? e.message : String(e);
  } finally {
    installingSlug.value = null;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex gap-2">
      <input v-model="searchQuery" :placeholder="t('skills.search.placeholder')"
        @keydown.enter="search"
        class="flex-1 rounded-lg border border-line bg-ink-1 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
      <input v-model="searchOwner" :placeholder="t('skills.search.owner')"
        class="w-28 rounded-lg border border-line bg-ink-1 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
      <button @click="search" :disabled="searching"
        class="flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-4 py-1.5 text-[12.5px] font-medium text-on-accent transition-opacity disabled:opacity-50">
        <Loader2 v-if="searching" :size="13" class="animate-spin" />
        <Search v-else :size="13" />
        {{ t("skills.search.action") }}
      </button>
    </div>

    <p v-if="searchError" class="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[12px] text-danger">
      <AlertTriangle :size="13" class="shrink-0" />{{ searchError }}
    </p>

    <div v-if="searching" class="flex items-center justify-center gap-2 py-8 text-[12px] text-lo">
      <Loader2 :size="14" class="animate-spin" /> {{ t("skills.search.searching") }}
    </div>

    <div v-else-if="searched && !searchResults.length" class="flex flex-col items-center gap-2 py-8 text-center">
      <Package :size="28" class="text-lo" />
      <p class="text-[12px] text-lo">{{ t("skills.search.noResults") }}</p>
      <p class="text-[11px] text-lo/70">{{ t("skills.search.browseMore") }}<a href="https://skills.sh" target="_blank" class="text-accent underline">skills.sh</a></p>
    </div>

    <div v-else-if="searchResults.length" class="space-y-2">
      <div v-for="s in searchResults" :key="s.slug"
        class="rounded-xl border border-line bg-ink-3/40 p-3 transition-colors hover:border-line-strong">
        <div class="flex items-start gap-2.5">
          <Package :size="14" class="mt-0.5 shrink-0 text-info" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-[12.5px] font-medium text-hi">{{ s.name }}</span>
              <span v-if="s.installsLabel" class="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">{{ s.installsLabel }}</span>
            </div>
            <a :href="s.url" target="_blank"
              class="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-mid transition-colors hover:text-accent hover:underline">
              <ExternalLink :size="11" class="shrink-0" />
              {{ s.source }}
            </a>
            <p v-if="installError[s.slug]" class="mt-1 text-[10.5px] text-danger">{{ installError[s.slug] }}</p>
          </div>
          <!-- 安装按钮（右侧居中） -->
          <div class="flex shrink-0 items-center self-center">
            <button v-if="isInstalled(s)"
              disabled
              class="inline-flex cursor-not-allowed items-center gap-1 rounded-lg border border-accent/30 bg-accent-soft px-2.5 py-1.5 text-[11.5px] text-accent opacity-70">
              <Check :size="12" /> {{ t("skills.search.installed") }}
            </button>
            <button v-else @click="install(s)" :disabled="installingSlug === s.slug"
              class="inline-flex items-center gap-1 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-2.5 py-1.5 text-[11.5px] font-medium text-on-accent transition-opacity disabled:opacity-50">
              <Loader2 v-if="installingSlug === s.slug" :size="12" class="animate-spin" />
              <Download v-else :size="12" />
              {{ installingSlug === s.slug ? t("skills.search.installing") : t("skills.search.install") }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="flex flex-col items-center gap-2 py-8 text-center">
      <Search :size="28" class="text-lo" />
      <p class="text-[12px] text-lo">{{ t("skills.search.hint") }}</p>
      <p class="text-[11px] text-lo/70">{{ t("skills.search.hint2") }}</p>
    </div>
  </div>
</template>