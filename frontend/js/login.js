const serverUrlInput = document.getElementById('server-url');
const configuredWebSocketUrl = window.SCREEN_SHARE_CONFIG?.websocketUrl;
const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
serverUrlInput.value = configuredWebSocketUrl || (isLocalHost ? 'ws://localhost:8080/signal' : '');

document.getElementById('login-form').addEventListener('submit', (event) => {
            event.preventDefault();
            const name = document.getElementById('participant-name').value.trim();
            const url = document.getElementById('server-url').value.trim();
            const password = document.getElementById('room-password').value.trim();
            const statusMsg = document.getElementById('status-msg');

            try {
                if (!name) {
                    throw new Error('Informe seu nome para entrar na sala.');
                }
                const parsedUrl = new URL(url);
                if (!['ws:', 'wss:'].includes(parsedUrl.protocol)) {
                    throw new Error('URL do servidor inválida.');
                }
                sessionStorage.setItem('screenShareConfig', JSON.stringify({ url, password, name }));
                window.location.assign('room.html');
            } catch (error) {
                statusMsg.innerText = error instanceof DOMException
                    ? 'Não foi possível iniciar a sessão neste navegador.'
                    : error.message || 'URL do servidor inválida.';
            }
        });
