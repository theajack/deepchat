<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { ShieldAlert } from "lucide-vue-next";
import { transport, type IpcEventFrame } from "../../services/ipc";
import { agentApi } from "../../services/agentApi";
import { t } from "../../i18n";

interface Pending {
  requestId: string;
  toolName: string;
  args: unknown;
}
const pending = ref<Pending[]>([]);
let off: (() => void) | null = null;

function onEvent(frame: IpcEventFrame) {
  if (frame.event === "approval_request") {
    pending.value.push({
      requestId: (frame.data as any).requestId,
      toolName: (frame.data as any).toolName,
      args: (frame.data as any).args,
    });
  }
}

async function respond(requestId: string, decision: "allow" | "deny" | "always_allow") {
  pending.value = pending.value.filter((p) => p.requestId !== requestId);
  await agentApi.approvalRespond(requestId, decision);
}

onMounted(() => {
  off = transport.onEvent(onEvent);
});
onUnmounted(() => off?.());
</script>

<template>
  <Teleport to="body">
    <div v-if="pending.length" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div class="w-[420px] max-w-[90vw] rounded-2xl border border-line bg-ink-2 p-5 shadow-2xl">
        <div class="mb-3 flex items-center gap-2">
          <ShieldAlert :size="18" class="text-amber-400" />
          <span class="text-[14px] font-semibold text-hi">{{ t("approval.title") }}</span>
        </div>
        <div v-for="p in pending" :key="p.requestId" class="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
          <p class="text-[13px] text-hi">{{ t("approval.prompt") }} <b class="font-mono text-accent">{{ p.toolName }}</b></p>
          <pre class="mt-1.5 max-h-32 overflow-auto rounded-lg bg-ink-1 p-2 font-mono text-[11px] text-mid">{{ JSON.stringify(p.args, null, 2) }}</pre>
          <div class="mt-2.5 flex gap-2">
            <button @click="respond(p.requestId, 'allow')" class="flex-1 rounded-lg bg-emerald-500/85 py-1.5 text-[12.5px] font-medium text-white hover:bg-emerald-500">{{ t("approval.allow") }}</button>
            <button @click="respond(p.requestId, 'always_allow')" class="flex-1 rounded-lg border border-line bg-ink-3 py-1.5 text-[12.5px] text-mid hover:text-hi">{{ t("approval.alwaysAllow") }}</button>
            <button @click="respond(p.requestId, 'deny')" class="flex-1 rounded-lg bg-red-500/85 py-1.5 text-[12.5px] font-medium text-white hover:bg-red-500">{{ t("approval.deny") }}</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
