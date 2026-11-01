const configuredWebSocketUrl = window.SCREEN_SHARE_CONFIG?.websocketUrl;
const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const websocketUrl = configuredWebSocketUrl || (isLocalHost ? 'ws://localhost:8080/signal' : '');

document.getElementById('login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const password = document.getElementById('room-password').value.trim();
    const statusMsg = document.getElementById('status-msg');

    try {
        if (!websocketUrl) {
            throw new Error('O servidor da sala ainda não foi configurado.');
        }
        const parsedUrl = new URL(websocketUrl);
        if (!['ws:', 'wss:'].includes(parsedUrl.protocol)) {
            throw new Error('URL do servidor inválida.');
        }
        sessionStorage.setItem('screenShareConfig', JSON.stringify({
            url: parsedUrl.toString(),
            password
        }));
        window.location.assign('room.html');
    } catch (error) {
        statusMsg.innerText = error instanceof DOMException
            ? 'Não foi possível iniciar a sessão neste navegador.'
            : error.message || 'Não foi possível entrar na sala.';
    }
});
