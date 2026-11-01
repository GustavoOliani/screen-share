import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(frontendDirectory, 'dist');
const websocketUrl = process.env.WEBSOCKET_URL?.trim();

if (!websocketUrl) {
    throw new Error('Defina WEBSOCKET_URL com o endereço público wss:// do backend.');
}

const parsedWebSocketUrl = new URL(websocketUrl);
if (parsedWebSocketUrl.protocol !== 'wss:') {
    throw new Error('WEBSOCKET_URL deve usar wss:// para o deploy público.');
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
    cp(resolve(frontendDirectory, 'css'), resolve(outputDirectory, 'css'), { recursive: true }),
    cp(resolve(frontendDirectory, 'js'), resolve(outputDirectory, 'js'), { recursive: true }),
    cp(resolve(frontendDirectory, 'index.html'), resolve(outputDirectory, 'index.html')),
    cp(resolve(frontendDirectory, 'room.html'), resolve(outputDirectory, 'room.html'))
]);

const runtimeConfig = `window.SCREEN_SHARE_CONFIG = ${JSON.stringify({ websocketUrl })};\n`;
await writeFile(resolve(outputDirectory, 'js', 'config.js'), runtimeConfig);
