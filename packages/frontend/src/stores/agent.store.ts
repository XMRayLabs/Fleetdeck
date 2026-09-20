import { defineStore } from 'pinia';
import { ref } from 'vue';
type Reader = { connectionId: number; selection: () => string; recent: () => string };
const readers = new Map<string, Reader>();
export function registerAgentTerminal(sessionId: string, reader: Reader) { readers.set(sessionId, reader); return () => {if(readers.get(sessionId)===reader)readers.delete(sessionId);}; }
export const useAgentStore = defineStore('agent', () => {
  const open = ref(false); const initialized = ref(false); const width = ref(480);
  const monitorRequest = ref(0);
  const attachment = ref<{ connectionId: number; source: string; text: string; nonce: number } | null>(null);
  function show() { initialized.value = true; open.value = true; }
  function capture(sessionId: string, kind: 'selection' | 'recent') {
    const reader = readers.get(sessionId); if (!reader) return false;
    show(); attachment.value = { connectionId: reader.connectionId, source: kind, text: reader[kind]().slice(0, 64000), nonce: Date.now() }; return true;
  }
  function reset() { open.value = false; initialized.value = false; attachment.value = null; monitorRequest.value = 0; readers.clear(); }
  return { open, initialized, width, attachment, monitorRequest, show, capture, reset };
});
