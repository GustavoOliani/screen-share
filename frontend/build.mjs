import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(frontendDirectory, 'dist');
const websocketUrl = process.env.WEBSOCKET_URL?.trim();
const defaultIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let iceServers = defaultIceServers;

if (!websocketUrl) {
    throw new Error('Defina WEBSOCKET_URL com o endereço público wss:// do backend.');
}

const parsedWebSocketUrl = new URL(websocketUrl);
if (parsedWebSocketUrl.protocol !== 'wss:') {
    throw new Error('WEBSOCKET_URL deve usar wss:// para o deploy público.');
}

if (process.env.ICE_SERVERS_JSON?.trim()) {
    try {
        iceServers = JSON.parse(process.env.ICE_SERVERS_JSON);
    } catch (error) {
        throw new Error('ICE_SERVERS_JSON deve conter um array JSON válido de servidores ICE.', { cause: error });
    }
    const hasInvalidServer = !Array.isArray(iceServers)
        || iceServers.length === 0
        || iceServers.some((server) => {
            if (!server || typeof server !== 'object' || Array.isArray(server)) return true;
            const urls = server.urls;
            const serverUrls = typeof urls === 'string' ? [urls] : urls;
            return !Array.isArray(serverUrls)
                || serverUrls.length === 0
                || !serverUrls.every(url => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url.trim()))
                || (server.username !== undefined && typeof server.username !== 'string')
                || (server.credential !== undefined && typeof server.credential !== 'string');
        });
    if (hasInvalidServer) {
        throw new Error('ICE_SERVERS_JSON deve conter um array de servidores ICE com urls válidas.');
    }
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
    cp(resolve(frontendDirectory, 'common'), resolve(outputDirectory, 'common'), { recursive: true }),
    cp(resolve(frontendDirectory, 'pages'), resolve(outputDirectory, 'pages'), { recursive: true }),
    cp(resolve(frontendDirectory, 'favicon.svg'), resolve(outputDirectory, 'favicon.svg')),
    cp(resolve(frontendDirectory, 'index.html'), resolve(outputDirectory, 'index.html')),
    cp(resolve(frontendDirectory, 'room.html'), resolve(outputDirectory, 'room.html'))
]);

const runtimeConfig = `window.SCREEN_SHARE_CONFIG = ${JSON.stringify({ websocketUrl, iceServers })};\n`;
await writeFile(resolve(outputDirectory, 'common', 'config.js'), runtimeConfig);
