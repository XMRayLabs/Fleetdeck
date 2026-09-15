export const rdpResolutions = ['1024x768', '1280x720', '1366x768', '1600x900', '1920x1080', '2560x1440'];
// X11 keysyms used by the Guacamole protocol, not browser key codes.
export const rdpShortcuts = [
  { label: 'Ctrl+Alt+Delete', keys: [0xffe3, 0xffe9, 0xffff] },
  { label: 'Ctrl+Shift+Esc', keys: [0xffe3, 0xffe1, 0xff1b] },
  { label: 'Ctrl+Shift+Delete', keys: [0xffe3, 0xffe1, 0xffff] },
  { label: 'Alt+Tab', keys: [0xffe9, 0xff09] },
  { label: 'Alt+F4', keys: [0xffe9, 0xffc1] },
  { label: 'Win', keys: [0xffeb] },
  { label: 'Win+R', keys: [0xffeb, 0x72] },
  { label: 'Win+E', keys: [0xffeb, 0x65] },
  { label: 'Win+D', keys: [0xffeb, 0x64] },
  { label: 'Win+L', keys: [0xffeb, 0x6c] },
  { label: 'Esc', keys: [0xff1b] },
];
export function sendRdpShortcut(send: (pressed: number, key: number) => void, keys: number[]) {
  const pressed: number[] = [];
  try {
    for (const key of keys) { pressed.push(key); send(1, key); }
  } finally {
    for (const key of pressed.reverse()) send(0, key);
  }
}
