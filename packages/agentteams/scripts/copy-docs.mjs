import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const here = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

copyFileSync(root('LICENSE'), here('LICENSE'));
copyFileSync(root('README.md'), here('README.md'));
