import { defineStore } from "pinia";
import { ref } from "vue";
type Reader = {
  connectionId: number;
  selection: () => string;
  recent: () => string;
  focus?: () => void;
};
const readers = new Map<string, Reader>();
export function registerAgentTerminal(sessionId: string, reader: Reader) {
  readers.set(sessionId, reader);
  return () => {
    if (readers.get(sessionId) === reader) readers.delete(sessionId);
  };
}
export const useAgentStore = defineStore("agent", () => {
  const open = ref(false);
  const initialized = ref(false);
  const width = ref(480);
  const monitorRequest = ref(0);
  const focusRequest = ref(0);
  let returnSessionId: string | null = null;
  const attachment = ref<{
    connectionId: number;
    source: string;
    text: string;
    nonce: number;
    automatic: boolean;
  } | null>(null);
  function show() {
    initialized.value = true;
    open.value = true;
    focusRequest.value++;
  }
  function close(sessionId?: string | null) {
    open.value = false;
    const target = sessionId || returnSessionId;
    if (target) readers.get(target)?.focus?.();
  }
  function openTerminal(sessionId?: string | null) {
    const reader = sessionId ? readers.get(sessionId) : undefined;
    if (!reader || !sessionId) {
      show();
      return false;
    }
    return capture(
      sessionId,
      reader.selection() ? "selection" : "recent",
      true,
    );
  }
  function capture(
    sessionId: string,
    kind: "selection" | "recent",
    automatic = false,
  ) {
    const reader = readers.get(sessionId);
    if (
      !reader ||
      !Number.isSafeInteger(reader.connectionId) ||
      reader.connectionId <= 0
    )
      return false;
    returnSessionId = sessionId;
    show();
    attachment.value = {
      connectionId: reader.connectionId,
      source: kind,
      text: reader[kind]().slice(0, 64000),
      nonce: Date.now(),
      automatic,
    };
    return true;
  }
  function reset() {
    open.value = false;
    initialized.value = false;
    attachment.value = null;
    monitorRequest.value = 0;
    focusRequest.value = 0;
    returnSessionId = null;
    readers.clear();
  }
  return {
    open,
    initialized,
    width,
    attachment,
    monitorRequest,
    focusRequest,
    show,
    close,
    openTerminal,
    capture,
    reset,
  };
});
