<script setup lang="ts">
import { ref } from "vue";
import { FolderOpen, AlertTriangle, Check, Loader2, Package } from "lucide-vue-next";
import { agentApi } from "../../services/agentApi";
import { t } from "../../i18n";

const emit = defineEmits<{ installed: [names: string[]] }>();

const srcDir = ref("");
const skillFilter = ref("");
const loading = ref(false);
const error = ref("");
const result = ref<{ installed: string[]; skipped: string[] } | null>(null);

async function install() {
  if (!srcDir.value.trim()) {
    error.value = t("skills.local.enterPath");
    return;
  }
  loading.value = true;
  error.value = "";
  result.value = null;
  try {
    const res = await agentApi.skillInstallLocal(
      srcDir.value.trim(),
      undefined,
      skillFilter.value.trim()
        ? skillFilter.value.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    );
    result.value = res;
    if (res.installed.length) emit("installed", res.installed);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="grid gap-2.5 rounded-xl border border-line bg-ink-2/60 p-3">
      <div>
        <label class="text-[11px] font-medium text-lo">{{ t("skills.local.dir") }}</label>
        <input v-model="srcDir" :placeholder="t('skills.local.placeholder')"
          class="mt-1 w-full rounded-lg border border-line bg-ink-1 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
      </div>
      <div>
        <label class="text-[11px] font-medium text-lo">{{ t("skills.local.filter") }}</label>
        <input v-model="skillFilter" placeholder="my-skill, other-skill"
          class="mt-1 w-full rounded-lg border border-line bg-ink-1 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
      </div>
      <button @click="install" :disabled="loading"
        class="flex w-fit items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-4 py-1.5 text-[12.5px] font-medium text-on-accent transition-opacity disabled:opacity-50">
        <Loader2 v-if="loading" :size="13" class="animate-spin" />
        <FolderOpen v-else :size="13" />
        {{ loading ? t("skills.local.importing") : t("skills.local.import") }}
      </button>
    </div>

    <p v-if="error" class="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[12px] text-danger">
      <AlertTriangle :size="13" class="shrink-0" />{{ error }}
    </p>

    <div v-if="result" class="rounded-xl border border-accent/30 bg-accent-soft p-3">
      <div class="flex items-start gap-2.5">
        <Check :size="14" class="mt-0.5 shrink-0 text-accent" />
        <div class="min-w-0 flex-1">
          <p class="text-[12px] font-medium text-accent">
            {{ t("skills.local.installed", { count: result.installed.length }) }}
          </p>
          <div v-if="result.installed.length" class="mt-1.5 flex flex-wrap gap-1.5">
            <span v-for="n in result.installed" :key="n"
              class="rounded bg-ink-1 px-1.5 py-0.5 font-mono text-[10.5px] text-mid">{{ n }}</span>
          </div>
          <p v-if="result.skipped.length" class="mt-1.5 text-[11px] text-lo">
            {{ t("skills.local.skipped", { count: result.skipped.length }) }}
          </p>
        </div>
      </div>
    </div>

    <div v-else class="rounded-xl border border-line bg-ink-2/40 p-3">
      <div class="flex items-start gap-2">
        <Package :size="13" class="mt-0.5 shrink-0 text-lo" />
        <div class="text-[11.5px] text-lo">
          <p>{{ t("skills.local.desc") }}</p>
          <p class="mt-1.5">{{ t("skills.local.desc2") }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
