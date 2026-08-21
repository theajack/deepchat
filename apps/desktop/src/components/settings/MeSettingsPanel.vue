<script setup lang="ts">
import { ref, watch } from "vue";
import { Sparkles, User } from "lucide-vue-next";
import AvatarEditor from "../common/AvatarEditor.vue";
import { useSelfStore } from "../../stores/self";
import { useAppStore } from "../../stores/app";
import { useModelsStore } from "../../stores/models";
import { useSettingsStore } from "../../stores/settings";
import { chatApi } from "../../services/chatApi";
import { t } from "../../i18n";

const self = useSelfStore();
const app = useAppStore();
const models = useModelsStore();
const settings = useSettingsStore();

const name = ref("");
const avatar = ref<string | null>(null);
const intro = ref("");
const saving = ref(false);
const generating = ref(false);

watch(
  () => self.loaded,
  (loaded) => {
    if (loaded) {
      name.value = self.name;
      avatar.value = self.avatar;
      intro.value = self.intro;
    }
  },
  { immediate: true },
);

async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    await self.saveAll({ name: name.value.trim() || "Me", avatar: avatar.value, intro: intro.value.trim() });
    app.toast(t("common.saved"));
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

async function generateIntro() {
  const n = name.value.trim();
  if (!n) {
    app.toast(t("me.fillNameFirst"));
    return;
  }
  if (generating.value) return;
  generating.value = true;
  const prev = intro.value;
  intro.value = "";
  try {
    const defaultModelId = settings.values["default_model_id"];
    const model = defaultModelId ? models.items.find((m) => m.id === defaultModelId) : undefined;
    await chatApi.generateSelfIntro(
      {
        name: n,
        partial: prev,
        model_id: model?.id ?? null,
        model_provider: model ? undefined : "mock",
      },
      (delta) => {
        intro.value += delta;
      },
    );
    intro.value = intro.value.trim();
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
    intro.value = prev;
  } finally {
    generating.value = false;
  }
}
</script>

<template>
  <section class="rounded-xl border border-line bg-ink-2/40 p-5">
    <div class="flex items-center gap-2">
      <User :size="15" class="text-accent" />
      <h3 class="text-[13px] font-semibold tracking-wide text-hi">{{ t("me.profile") }}</h3>
    </div>
    <p class="mt-1 text-xs text-lo">{{ t("me.profileDesc") }}</p>

    <div class="mt-4 flex justify-center">
      <AvatarEditor v-model="avatar" :size="88" />
    </div>
  </section>

  <section class="rounded-xl border border-line bg-ink-2/40 p-5">
    <label class="mb-1.5 block text-xs text-mid">{{ t("me.name") }}</label>
    <input
      v-model="name"
      type="text"
      :placeholder="t('me.namePlaceholder')"
      class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
    />

    <div class="mb-1.5 mt-4 flex items-center justify-between">
      <label class="block text-xs text-mid">{{ t("me.intro") }}</label>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-line-strong/50 bg-ink-2/70 px-2.5 py-1 text-[11px] text-mid transition-all hover:border-accent/40 hover:bg-ink-3 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="generating || !name.trim()"
        :title="name.trim() ? t('me.generateSelfIntro') : t('me.fillNameFirst')"
        @click="generateIntro"
      >
        <svg v-if="generating" class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" stroke-dasharray="16 42" stroke-linecap="round"/></svg>
        <Sparkles v-else :size="12" />
        {{ generating ? t("me.generatingSelfIntro") : t("me.generateSelfIntro") }}
      </button>
    </div>
    <textarea
      v-model="intro"
      rows="3"
      :disabled="generating"
      :placeholder="t('me.introPlaceholder')"
      class="w-full resize-none rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-[13px] leading-relaxed text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:opacity-50"
    />

    <div class="mt-5 flex justify-end">
      <button
        class="rounded-lg bg-gradient-to-br from-accent to-accent-deep px-4 py-2 text-[13px] font-semibold text-on-accent shadow-[0_4px_18px_rgba(42,227,164,0.28)] transition-all hover:shadow-[0_4px_24px_var(--color-accent-glow)] hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:shadow-none"
        :disabled="saving"
        @click="save"
      >{{ t("common.save") }}</button>
    </div>
  </section>
</template>
