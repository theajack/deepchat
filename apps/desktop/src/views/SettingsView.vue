<script setup lang="ts">
import { computed } from "vue";
import { Cpu, Settings as SettingsIcon, Wrench, BookOpen, Server, Bug, User } from "lucide-vue-next";
import SettingsSidebar, { type SettingsSection } from "../components/settings/SettingsSidebar.vue";
import GeneralSettingsPanel from "../components/settings/GeneralSettingsPanel.vue";
import ModelSettingsPanel from "../components/settings/ModelSettingsPanel.vue";
import ToolsPanel from "../components/settings/ToolsPanel.vue";
import SkillsPanel from "../components/settings/SkillsPanel.vue";
import McpPanel from "../components/settings/McpPanel.vue";
import DebugPanel from "../components/settings/DebugPanel.vue";
import MeSettingsPanel from "../components/settings/MeSettingsPanel.vue";
import { useAppStore } from "../stores/app";
import { t } from "../i18n";

const app = useAppStore();

const SECTIONS = computed<SettingsSection[]>(() => [
  { id: "me", label: t("settings.me"), icon: User, desc: t("settings.meDesc") },
  { id: "general", label: t("settings.general"), icon: SettingsIcon, desc: t("settings.generalDesc") },
  { id: "model", label: t("settings.model"), icon: Cpu, desc: t("settings.modelDesc") },
  { id: "tools", label: t("settings.tools"), icon: Wrench, desc: t("settings.toolsDesc") },
  { id: "skills", label: t("settings.skills"), icon: BookOpen, desc: t("settings.skillsDesc") },
  { id: "mcp", label: t("settings.mcp"), icon: Server, desc: t("settings.mcpDesc") },
  { id: "debug", label: t("settings.debug"), icon: Bug, desc: t("settings.debugDesc") },
]);
</script>

<template>
  <main class="flex min-w-0 flex-1">
    <SettingsSidebar :sections="SECTIONS" :active="app.settingsSection" @select="app.navigateToSettings($event)" />
    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-13 shrink-0 items-center border-b border-line bg-ink-1/50 px-5">
        <h2 class="text-sm font-semibold tracking-wide text-hi">
          {{ SECTIONS.find((s) => s.id === app.settingsSection)?.label ?? t("settings.title") }}
        </h2>
      </header>
      <div class="flex-1 overflow-y-auto p-6">
        <div class="mx-auto flex max-w-130 flex-col gap-5">
          <MeSettingsPanel v-if="app.settingsSection === 'me'" />
          <GeneralSettingsPanel v-if="app.settingsSection === 'general'" />
          <ModelSettingsPanel v-if="app.settingsSection === 'model'" />
          <ToolsPanel v-if="app.settingsSection === 'tools'" />
          <SkillsPanel v-if="app.settingsSection === 'skills'" />
          <McpPanel v-if="app.settingsSection === 'mcp'" />
          <DebugPanel v-if="app.settingsSection === 'debug'" />
        </div>
      </div>
    </div>
  </main>
</template>
