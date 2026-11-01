class RoomService {
    constructor(handlers) {
        this.handlers = handlers;
        this.socket = null;
        this.intentionalDisconnect = false;
        this.hasConnectionError = false;
    }

    connect({ url, password }) {
        try {
            this.socket = new WebSocket(url);
        } catch (error) {
            this.reportConnectionError('URL do servidor inválida.');
            return;
        }

        this.socket.onopen = () => {
            this.socket.send(JSON.stringify({
                type: 'JOIN',
                roomPassword: password
            }));
        };

        this.socket.onmessage = async (event) => {
            try {
                await this.handleMessage(JSON.parse(event.data));
            } catch (error) {
                this.handlers.onMessageError(error);
            }
        };

        this.socket.onerror = () => {
            this.reportConnectionError('Erro de conexão com o servidor.');
        };

        this.socket.onclose = () => {
            if (!this.intentionalDisconnect && !this.hasConnectionError) {
                this.reportConnectionError('Conexão com o servidor encerrada.');
            }
        };
    }

    sendSignal(type, targetId, payload) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error('A conexão com o servidor de sinalização não está aberta.');
        }
        this.socket.send(JSON.stringify({ type, targetId, payload }));
    }

    disconnect() {
        this.intentionalDisconnect = true;
        if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
            this.socket.close();
        }
    }

    async handleMessage(data) {
        switch (data.type) {
            case 'ROOM_JOINED':
                await this.handlers.onJoined(data);
                break;
            case 'ERROR':
                this.reportConnectionError(data.payload || 'Erro ao entrar na sala.');
                this.disconnect();
                break;
            case 'PEER_JOINED':
                this.handlers.onPeerJoined(data.senderId);
                break;
            case 'PEER_LEFT':
                this.handlers.onPeerLeft(data.senderId);
                break;
            case 'OFFER':
                await this.handlers.onOffer(data.senderId, JSON.parse(data.payload));
                break;
            case 'ANSWER':
                await this.handlers.onAnswer(data.senderId, JSON.parse(data.payload));
                break;
            case 'CANDIDATE':
                await this.handlers.onCandidate(data.senderId, JSON.parse(data.payload));
                break;
        }
    }

    reportConnectionError(message) {
        if (this.hasConnectionError) return;
        this.hasConnectionError = true;
        this.handlers.onConnectionError(message);
    }
}

window.RoomService = RoomService;
