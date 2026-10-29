import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '../apps/desktop');

const appIcon = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="236" fill="#111214"/>
  <rect x="1.5" y="1.5" width="1021" height="1021" rx="234.5" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="3"/>
  <g fill="#f7f7f8">
    <rect x="350" y="438" width="76" height="248" rx="38"/>
    <rect x="474" y="324" width="76" height="476" rx="38"/>
    <rect x="598" y="392" width="76" height="340" rx="38"/>
  </g>
</svg>`;

const trayWindows = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <g fill="#ffffff" stroke="#111214" stroke-width="0.9" stroke-linejoin="round">
    <rect x="6" y="12" width="4.6" height="9" rx="2.3"/>
    <rect x="13.7" y="6.5" width="4.6" height="19" rx="2.3"/>
    <rect x="21.4" y="9.5" width="4.6" height="13" rx="2.3"/>
  </g>
</svg>`;

const trayTemplate = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <g fill="#000000">
    <rect x="6" y="12" width="4.6" height="9" rx="2.3"/>
    <rect x="13.7" y="6.5" width="4.6" height="19" rx="2.3"/>
    <rect x="21.4" y="9.5" width="4.6" height="13" rx="2.3"/>
  </g>
</svg>`;

await mkdir(resolve(desktop, 'build'), { recursive: true });
await mkdir(resolve(desktop, 'src/main/assets'), { recursive: true });
await mkdir(resolve(here, '../docs'), { recursive: true });

await sharp(Buffer.from(appIcon)).resize(1024, 1024).png().toFile(resolve(desktop, 'build/icon.png'));
await sharp(Buffer.from(appIcon)).resize(512, 512).png().toFile(resolve(desktop, 'src/main/assets/appIcon.png'));
await sharp(Buffer.from(trayWindows)).png().toFile(resolve(desktop, 'src/main/assets/tray.png'));
await sharp(Buffer.from(trayTemplate)).png().toFile(resolve(desktop, 'src/main/assets/trayTemplate.png'));
await sharp(Buffer.from(appIcon)).resize(256, 256).png().toFile(resolve(here, '../docs/icon.png'));

console.log('icons written');
