import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Build local SVG masks from the installed Font Awesome Free package (CC BY 4.0).
// Keep the existing icon classes, but do not depend on downloadable icon fonts.
export default function fleetdeckIcons() {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata/icon-families.json'), 'utf8'));
  const aliases = new Map();
  for (const [name, entry] of Object.entries(metadata)) {
    for (const alias of [name, ...(entry.aliases?.names || [])]) aliases.set(alias, name);
  }
  const id = 'virtual:fleetdeck-icons.css';
  return {
    name: 'fleetdeck-local-icons',
    resolveId(source) { if (source === id) return '\0' + id; },
    load(source) {
      if (source !== '\0' + id) return;
      const used = new Set();
      const scan = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) scan(file);
          else if (/\.(vue|ts|css)$/.test(file)) {
            this.addWatchFile(file);
            for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bfa-([a-z0-9]+(?:-[a-z0-9]+)*)/g)) used.add(match[1]);
          }
        }
      };
      scan(fileURLToPath(new URL('./src', import.meta.url)));
      const rules = ['/*! Font Awesome Free icons by Fonticons, Inc. — https://fontawesome.com/license/free — CC BY 4.0 */',
        ':is(.fa,.fas,.far,.fab,.fa-solid,.fa-regular,.fa-brands){display:inline-block;font-style:normal;line-height:1;flex-shrink:0}',
        ':is(.fa,.fas,.far,.fab,.fa-solid,.fa-regular,.fa-brands)::before{content:"";display:inline-block;width:1em;height:1em;vertical-align:-.125em;background-color:currentColor;mask:var(--fd-icon) center/contain no-repeat;-webkit-mask:var(--fd-icon) center/contain no-repeat}',
        '.fa-xs{font-size:.75em}.fa-sm{font-size:.875em}.fa-lg{font-size:1.25em}.fa-2x{font-size:2em}.fa-3x{font-size:3em}.fa-fw{width:1.25em;text-align:center}.fa-spin{animation:fd-icon-spin 2s linear infinite}.fa-pulse{animation:fd-icon-spin 1s steps(8) infinite}@keyframes fd-icon-spin{to{transform:rotate(360deg)}}',
        '@media(prefers-reduced-motion:reduce){.fa-spin,.fa-pulse{animation:none}}'];
      for (const name of used) {
        const canonical = aliases.get(name);
        if (!canonical) continue; // Layout/animation/size utility, not an icon name.
        for (const [style, classes] of Object.entries({ solid: ['fa','fas','fa-solid'], regular: ['far','fa-regular'], brands: ['fab','fa-brands'] })) {
          const file = path.join(root, 'svgs', style, canonical + '.svg');
          if (!fs.existsSync(file)) continue;
          const svg = fs.readFileSync(file, 'utf8').replace(/<!--.*?-->/gs, '');
          const url = 'data:image/svg+xml,' + encodeURIComponent(svg).replaceAll("'", '%27');
          rules.push(`${classes.map(cls => `.${cls}.fa-${name}`).join(',')}{--fd-icon:url("${url}")}`);
        }
      }
      return rules.join('\n');
    },
  };
}
