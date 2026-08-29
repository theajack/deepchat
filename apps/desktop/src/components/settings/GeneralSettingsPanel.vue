<script setup lang="ts">
import { Monitor, Moon, Sun, FolderOpen, ExternalLink, Globe, AppWindow, Palette, Languages } from "lucide-vue-next";
import { computed, onMounted, ref } from "vue";
import { useThemeStore, type ThemeMode } from "../../stores/theme";
import { useLocaleStore } from "../../stores/locale";
import { useAppStore } from "../../stores/app";
import { chatApi } from "../../services/chatApi";
import { agentApi } from "../../services/agentApi";
import { getBrowserPref, setBrowserPref, type BrowserPref } from "../../utils/browser";
import { t, type Locale } from "../../i18n";

const theme = useThemeStore();
const locale = useLocaleStore();
const app = useAppStore();

const options = computed<{ value: ThemeMode; label: string; icon: typeof Sun }[]>(() => [
  { value: "light", label: t("theme.light"), icon: Sun },
  { value: "dark", label: t("theme.dark"), icon: Moon },
  { value: "system", label: t("theme.system"), icon: Monitor },
]);

const languageOptions = computed<{ value: Locale; label: string; icon: typeof Languages }[]>(() => [
  { value: "zh", label: t("language.zh"), icon: Languages },
  { value: "en", label: t("language.en"), icon: Globe },
  { value: "system", label: t("language.system"), icon: Monitor },
]);

function choose(opt: ThemeMode, e: MouseEvent) {
  theme.setMode(opt, { x: e.clientX, y: e.clientY });
}

function chooseLanguage(opt: Locale) {
  locale.setLocale(opt);
}

const workspaceDir = ref("");
const dataDirPaths = ref<Record<string, string>>({});
const browserPref = ref<BrowserPref>("system");

const browserOptions = computed<{ value: BrowserPref; label: string; desc: string; icon: typeof Globe }[]>(() => [
  { value: "builtin", label: t("browser.builtin"), desc: t("browser.builtinDesc"), icon: AppWindow },
  { value: "system", label: t("browser.system"), desc: t("browser.systemDesc"), icon: Globe },
]);

async function chooseBrowser(pref: BrowserPref) {
  browserPref.value = pref;
  await setBrowserPref(pref);
}

async function openDataDir(name: string) {
  const dir = name === '' ? workspaceDir.value : dataDirPaths.value[name];
  if (!dir) return;
  try {
    await agentApi.toolOpenDir(dir);
  } catch (e) {
    console.error("[general] 打开目录失败", e);
    app.toast(t("dataDir.openFailed"));
  }
}

onMounted(async () => {
  try {
    const { root, dirs } = await chatApi.dataDirs();
    workspaceDir.value = root;
    dataDirPaths.value = Object.fromEntries(dirs.map((d) => [d.name, d.path]));
  } catch { /* ignore */ }
  browserPref.value = getBrowserPref();
});
</script>

<template>
  <section class="rounded-xl border border-line bg-ink-2/40 p-5">
    <div class="flex items-center gap-2">
      <Palette :size="15" class="text-accent" />
      <h3 class="text-[13px] font-semibold tracking-wide text-hi">{{ t("general.theme") }}</h3>
    </div>
    <p class="mt-1 text-xs text-lo">{{ t("general.themeDesc") }}</p>
    <div class="mt-3 inline-flex w-full rounded-xl border border-line bg-ink-1/60 p-1">
      <button
        v-for="opt in options"
        :key="opt.value"
        type="button"
        class="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all"
        :class="
          theme.mode === opt.value
            ? 'border border-accent/50 bg-accent-soft text-accent shadow-[0_3px_14px_rgba(42,227,164,0.12)]'
            : 'text-mid hover:bg-ink-3 hover:text-hi'
        "
        @click="choose(opt.value, $event)"
      >
        <component :is="opt.icon" :size="15" :stroke-width="1.8" />
        {{ opt.label }}
      </button>
    </div>
  </section>

  <section class="rounded-xl border border-line bg-ink-2/40 p-5">
    <div class="flex items-center gap-2">
      <Languages :size="15" class="text-accent" />
      <h3 class="text-[13px] font-semibold tracking-wide text-hi">{{ t("general.language") }}</h3>
    </div>
    <p class="mt-1 text-xs text-lo">{{ t("general.languageDesc") }}</p>
    <div class="mt-3 inline-flex w-full rounded-xl border border-line bg-ink-1/60 p-1">
      <button
        v-for="opt in languageOptions"
        :key="opt.value"
        type="button"
        class="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all"
        :class="
          locale.locale === opt.value
            ? 'border border-accent/50 bg-accent-soft text-accent shadow-[0_3px_14px_rgba(42,227,164,0.12)]'
            : 'text-mid hover:bg-ink-3 hover:text-hi'
        "
        @click="chooseLanguage(opt.value)"
      >
        <component :is="opt.icon" :size="15" :stroke-width="1.8" />
        {{ opt.label }}
      </button>
    </div>
  </section>

  <section class="rounded-xl border border-line bg-ink-2/40 p-5">
    <div class="flex items-center gap-2">
      <Globe :size="15" class="text-accent" />
      <h3 class="text-[13px] font-semibold tracking-wide text-hi">{{ t("general.browser") }}</h3>
    </div>
    <p class="mt-1 text-xs text-lo">{{ t("general.browserDesc") }}</p>
    <div class="mt-3 inline-flex w-full rounded-xl border border-line bg-ink-1/60 p-1">
      <button
        v-for="opt in browserOptions"
        :key="opt.value"
        type="button"
        class="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all"
        :class="
          browserPref === opt.value
            ? 'border border-accent/50 bg-accent-soft text-accent shadow-[0_3px_14px_rgba(42,227,164,0.12)]'
            : 'text-mid hover:bg-ink-3 hover:text-hi'
        "
        @click="chooseBrowser(opt.value)"
      >
        <component :is="opt.icon" :size="15" :stroke-width="1.8" />
        {{ opt.label }}
      </button>
    </div>
  </section>

  <section class="rounded-xl border border-line bg-ink-2/40 p-5">
    <div class="flex items-center gap-2">
      <FolderOpen :size="15" class="text-accent" />
      <h3 class="text-[13px] font-semibold tracking-wide text-hi">{{ t("general.dataDir") }}</h3>
    </div>
    <p class="mt-1 text-xs text-lo">
      {{ t("general.dataDirDesc") }}
    </p>
    <div
      class="mt-3 flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-ink-1/60 px-3 py-2.5 transition-colors hover:bg-ink-3"
      @click="openDataDir('')"
    >
      <FolderOpen :size="16" class="shrink-0 text-accent" />
      <div class="min-w-0 flex-1">
        <p class="text-[12px] leading-relaxed text-mid">{{ t("dataDir.root") }}</p>
        <p class="truncate font-mono text-[11px] text-lo">{{ workspaceDir }}</p>
      </div>
      <ExternalLink :size="14" class="shrink-0 text-lo transition-colors group-hover:text-accent" />
    </div>
  </section>
</template>
