<script setup lang="ts">
import { ref } from "vue";
import { Plus, AlertTriangle, Check, Loader2 } from "lucide-vue-next";
import { agentApi } from "../../services/agentApi";
import { t } from "../../i18n";

const emit = defineEmits<{ installed: [names: string[]] }>();

const newName = ref("");
const newDesc = ref("");
const creating = ref(false);
const createError = ref("");
const createSuccess = ref("");

async function create() {
  if (!newName.value.trim()) {
    createError.value = t("skills.create.enterName");
    return;
  }
  if (!newDesc.value.trim()) {
    createError.value = t("skills.create.enterDesc");
    return;
  }
  creating.value = true;
  createError.value = "";
  createSuccess.value = "";
  try {
    const res = await agentApi.skillCreate(
      undefined,
      newName.value.trim(),
      newDesc.value.trim(),
    );
    createSuccess.value = res.location;
    emit("installed", [newName.value.trim()]);
    newName.value = "";
    newDesc.value = "";
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="grid gap-2.5 rounded-xl border border-line bg-ink-2/60 p-3">
      <div>
        <label class="text-[11px] font-medium text-lo">{{ t("skills.create.name") }}</label>
        <input v-model="newName" :placeholder="t('skills.create.namePlaceholder')"
          class="mt-1 w-full rounded-lg border border-line bg-ink-1 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
      </div>
      <div>
        <label class="text-[11px] font-medium text-lo">{{ t("skills.create.desc") }}</label>
        <textarea v-model="newDesc" rows="3" :placeholder="t('skills.create.descPlaceholder')"
          class="mt-1 w-full resize-none rounded-lg border border-line bg-ink-1 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent"></textarea>
      </div>
      <button @click="create" :disabled="creating"
        class="flex w-fit items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-4 py-1.5 text-[12.5px] font-medium text-on-accent transition-opacity disabled:opacity-50">
        <Loader2 v-if="creating" :size="13" class="animate-spin" />
        <Plus v-else :size="13" />
        {{ creating ? t("skills.create.creating") : t("skills.create.action") }}
      </button>
    </div>

    <p v-if="createError" class="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[12px] text-danger">
      <AlertTriangle :size="13" class="shrink-0" />{{ createError }}
    </p>

    <div v-if="createSuccess" class="flex items-start gap-2.5 rounded-xl border border-accent/30 bg-accent-soft p-3">
      <Check :size="14" class="mt-0.5 shrink-0 text-accent" />
      <div class="min-w-0">
        <p class="text-[12px] font-medium text-accent">{{ t("skills.create.created") }}</p>
        <p class="mt-0.5 truncate font-mono text-[10.5px] text-mid">{{ createSuccess }}</p>
      </div>
    </div>

    <div v-else class="rounded-xl border border-line bg-ink-2/40 p-3">
      <p class="text-[11.5px] text-lo">{{ t("skills.create.template") }}</p>
      <pre class="mt-2 overflow-x-auto rounded-lg border border-line bg-ink-1/60 p-2.5 font-mono text-[10.5px] leading-relaxed text-mid">---
name: my-skill
description: {{ t("skills.create.templateDesc") }}
---

# My Skill

## When to Use
## Steps
## Examples</pre>
    </div>
  </div>
</template>
