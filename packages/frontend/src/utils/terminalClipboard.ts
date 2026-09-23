/** Keep clipboard data out of logs and use xterm.paste for bracketed-paste support. */
export async function copyTerminalText(text: string): Promise<boolean> {
  if (!text) return false;
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* Legacy secure-context/permission fallback below. */ }
  const previous = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text; field.setAttribute('readonly', ''); field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
  document.body.append(field); field.select();
  try { return document.execCommand('copy'); } catch { return false; }
  finally { field.remove(); previous?.focus({ preventScroll: true }); }
}
export function terminalClipboardKey(event: KeyboardEvent): 'copy' | 'paste' | null {
  if (event.altKey) return null;
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyC' || event.metaKey && !event.ctrlKey && event.code === 'KeyC' || event.ctrlKey && event.code === 'Insert') return 'copy';
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyV' || event.shiftKey && !event.ctrlKey && event.code === 'Insert') return 'paste';
  // Ctrl+C always remains SIGINT; Ctrl+V and Cmd+V use the browser paste event.
  return null;
}
