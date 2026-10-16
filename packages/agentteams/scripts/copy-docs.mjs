import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const here = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const { name, version } = JSON.parse(readFileSync(here('package.json'), 'utf8'));

copyFileSync(root('LICENSE'), here('LICENSE'));
mkdirSync(here('assets'), { recursive: true });
for (const f of ['banner.svg', 'logo.svg']) copyFileSync(root(`assets/${f}`), here(`assets/${f}`));

// npm can't resolve relative image paths, so point them at this version's copy on the CDN.
const readme = readFileSync(root('README.md'), 'utf8')
  .replaceAll('src="assets/', `src="https://cdn.jsdelivr.net/npm/${name}@${version}/assets/`);
writeFileSync(here('README.md'), readme);
