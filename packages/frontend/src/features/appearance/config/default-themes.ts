import type { ITheme } from 'xterm';

// 默认 xterm 主题
// (与 backend/src/config/default-themes.ts 中的定义保持一致)
export const defaultXtermTheme: ITheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  selectionBackground: '#264f78', // 使用 selectionBackground
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
  '--link-color': '#1d4ed8', // Console accent
  '--link-hover-color': '#1e40af', // Console accent
  '--link-active-color': '#2563eb', // Console accent
  '--link-active-bg-color': '#eff6ff', /* Subtle accent surface */
  '--nav-item-active-bg-color': 'var(--link-active-bg-color)', /* Added */
  '--header-bg-color': '#f8fafc',
  '--footer-bg-color': '#f8fafc',
  '--button-bg-color': '#2563eb', // Console accent
  '--button-text-color': '#ffffff',
  '--button-hover-bg-color': '#1d4ed8', // Console accent
  '--icon-color': 'var(--text-color-secondary)', // 图标颜色
  '--icon-hover-color': 'var(--link-hover-color)', // 图标悬停颜色 (自动更新)
  '--split-line-color': 'var(--border-color)', /* 分割线颜色 */
  '--split-line-hover-color': 'var(--border-color)', /* 分割线悬停颜色 */
  '--input-focus-border-color': 'var(--link-active-color)', /* 输入框聚焦边框颜色 (自动更新) */
  '--input-focus-glow': 'var(--link-active-color)', /* 输入框聚焦光晕值 (自动更新) */
  '--overlay-bg-color': 'rgba(0, 0, 0, 0.6)', /* Added Overlay Background - 恢复 rgba 以支持透明度 */
  '--font-family-sans-serif': 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Microsoft YaHei, sans-serif',
  '--base-padding': '1rem',
  '--base-margin': '0.5rem',
};
