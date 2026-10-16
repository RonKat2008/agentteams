import { copyFileSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const here = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const { name, version } = JSON.parse(readFileSync(here('package.json'), 'utf8'));

copyFileSync(root('LICENSE'), here('LICENSE'));
rmSync(here('assets'), { recursive: true, force: true });
cpSync(root('assets'), here('assets'), { recursive: true });

// npm can't resolve relative image paths, so point them at this version's copy on the CDN.
const readme = readFileSync(root('README.md'), 'utf8')
  .replaceAll('src="assets/', `src="https://cdn.jsdelivr.net/npm/${name}@${version}/assets/`);
writeFileSync(here('README.md'), readme);
