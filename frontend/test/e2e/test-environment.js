const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const frontendDirectory = path.resolve(__dirname, '../..');
const backendJar = path.resolve(frontendDirectory, '../backend/target/screen-share-web-1.0.0.jar');
const javaExecutable = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : 'java';
const roomPassword = 'screen-share-e2e-test-password';
const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml'
};

function findUnusedPort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(error => error ? reject(error) : resolve(port));
        });
    });
}

function isBackendReady(port) {
    return new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.setTimeout(500);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
        });
    });
}

function createFrontendServer(backendPort) {
    return http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        if (pathname === '/__e2e_health') {
            void isBackendReady(backendPort).then(ready => {
                response.writeHead(ready ? 200 : 503);
                response.end(ready ? 'ready' : 'backend is unavailable');
            });
            return;
        }

        if (pathname === '/common/config.js') {
            response.writeHead(200, { 'Content-Type': mimeTypes['.js'] });
            response.end(`window.SCREEN_SHARE_CONFIG = ${JSON.stringify({
                websocketUrl: `ws://127.0.0.1:${backendPort}/signal`,
                iceServers: []
            })};\n`);
            return;
        }

        let filePath;
        try {
            const decodedPath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
            filePath = path.resolve(frontendDirectory, `.${decodedPath}`);
        } catch {
            response.writeHead(400);
            response.end('Invalid path');
            return;
        }

        if (filePath !== frontendDirectory
            && !filePath.startsWith(`${frontendDirectory}${path.sep}`)) {
            response.writeHead(404);
            response.end('Not found');
            return;
        }

        fs.readFile(filePath, (error, content) => {
            if (error) {
                response.writeHead(error.code === 'ENOENT' ? 404 : 500);
                response.end(error.code === 'ENOENT' ? 'Not found' : 'Could not read file');
                return;
            }
            response.writeHead(200, {
                'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream'
            });
            response.end(content);
        });
    });
}

async function waitForBackend(process, port, output) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (process.exitCode !== null) {
            throw new Error(`Backend exited with code ${process.exitCode}.\n${output.join('')}`);
        }
        if (await isBackendReady(port)) return;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Backend did not start listening on port ${port}.\n${output.join('')}`);
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function closeServer(server) {
    if (!server?.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

function stopProcess(child) {
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
        }, 5000);
        child.once('exit', () => {
            clearTimeout(timeout);
            resolve();
        });
        child.kill();
    });
}

async function startTestEnvironment() {
    if (!fs.existsSync(backendJar)) {
        throw new Error(`Backend JAR not found at ${backendJar}. Run the test:e2e script.`);
    }

    const backendPort = await findUnusedPort();
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-share-e2e-'));
    const backendOutput = [];
    const backendProcess = spawn(javaExecutable, [`-Duser.dir=${temporaryDirectory}`, '-jar', backendJar], {
        cwd: frontendDirectory,
        env: {
            ...process.env,
            ROOM_PASSWORD: roomPassword,
            PORT: String(backendPort),
            FRONTEND_ORIGIN: '*'
        },
        windowsHide: true
    });
    backendProcess.stdout.on('data', chunk => backendOutput.push(chunk.toString()));
    backendProcess.stderr.on('data', chunk => backendOutput.push(chunk.toString()));

    let frontendServer;
    try {
        await waitForBackend(backendProcess, backendPort, backendOutput);
        frontendServer = createFrontendServer(backendPort);
        const frontendPort = await listen(frontendServer);
        return {
            baseUrl: `http://127.0.0.1:${frontendPort}`,
            backendOutput,
            backendProcess,
            frontendServer,
            roomPassword,
            temporaryDirectory
        };
    } catch (error) {
        await closeServer(frontendServer);
        await stopProcess(backendProcess);
        fs.rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        throw error;
    }
}

async function stopTestEnvironment(environment) {
    if (!environment) return;
    await closeServer(environment.frontendServer);
    await stopProcess(environment.backendProcess);
    fs.rmSync(environment.temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200
    });
}

module.exports = { startTestEnvironment, stopTestEnvironment };
