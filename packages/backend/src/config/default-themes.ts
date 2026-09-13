import type { ITheme } from 'xterm';

// 默认 xterm 主题
// (与 backend/src/config/default-themes.ts 中的定义保持一致)
export const defaultXtermTheme: ITheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5'
};

// 默认 UI 主题 (CSS 变量)
// (与 backend/src/config/default-themes.ts 中的定义保持一致)
export const defaultUiTheme: Record<string, string> = {
  '--app-bg-color': '#ffffff',
  '--text-color': '#1e293b',
  '--text-color-secondary': '#64748b',
  '--border-color': '#e2e8f0',
  '--link-color': '#1d4ed8',
  '--link-hover-color': '#1e40af',
  '--link-active-color': '#2563eb',
  '--link-active-bg-color': '#eff6ff',
  '--nav-item-active-bg-color': 'var(--link-active-bg-color)',
  '--header-bg-color': '#f8fafc',
  '--footer-bg-color': '#f8fafc',
  '--button-bg-color': '#2563eb',
  '--button-text-color': '#ffffff',
  '--button-hover-bg-color': '#1d4ed8',
  '--icon-color': 'var(--text-color-secondary)',
  '--icon-hover-color': 'var(--link-hover-color)',
  '--split-line-color': 'var(--border-color)',
  '--split-line-hover-color': 'var(--border-color)',
  '--input-focus-border-color': 'var(--link-active-color)',
  '--input-focus-glow': 'var(--link-active-color)',
  '--overlay-bg-color': 'rgba(0, 0, 0, 0.6)',
  '--font-family-sans-serif': 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Microsoft YaHei, sans-serif',
  '--base-padding': '1rem',
  '--base-margin': '0.5rem',
};
