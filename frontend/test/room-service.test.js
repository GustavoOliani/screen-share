const assert = require('node:assert/strict');
const { test } = require('node:test');

globalThis.window = {};
require('../pages/room/room-service.js');
const RoomService = globalThis.window.RoomService;

function spy(implementation = () => {}) {
    const calls = [];
    const fn = (...args) => {
        calls.push(args);
        return implementation(...args);
    };
    fn.calls = calls;
    return fn;
}

class FakeWebSocket {
    static OPEN = 1;
    static CLOSING = 2;
    static instances = [];
    static nextError = null;

    constructor(url) {
        if (FakeWebSocket.nextError) {
            const error = FakeWebSocket.nextError;
            FakeWebSocket.nextError = null;
            throw error;
        }
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.closeCalls = 0;
        FakeWebSocket.instances.push(this);
    }

    send(message) {
        this.sent.push(message);
    }

    close() {
        this.closeCalls += 1;
        this.readyState = FakeWebSocket.CLOSING;
    }
}

globalThis.WebSocket = FakeWebSocket;

function createService() {
    const handlers = Object.fromEntries([
        'onAnswer',
        'onCandidate',
        'onConnectionError',
        'onJoined',
        'onMessageError',
        'onOffer',
        'onPeerJoined',
        'onPeerLeft'
    ].map(name => [name, spy()]));
    return { handlers, service: new RoomService(handlers) };
}

function openSocket(service) {
    service.connect({ url: 'wss://server.test/signal', password: 'secret' });
    const socket = service.socket;
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen();
    return socket;
}

test('opens the socket and sends the room password in the JOIN message', () => {
    const { service } = createService();
    const socket = openSocket(service);

    assert.equal(socket.url, 'wss://server.test/signal');
    assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'JOIN', roomPassword: 'secret' });
});

test('reports a synchronous socket construction error', () => {
    const { handlers, service } = createService();
    FakeWebSocket.nextError = new Error('invalid URL');

    service.connect({ url: 'not-a-url', password: 'secret' });

    assert.deepEqual(handlers.onConnectionError.calls, [['URL do servidor inválida.']]);
    assert.equal(service.socket, null);
});

test('sends signals only while the socket is open', () => {
    const { service } = createService();
    const socket = openSocket(service);

    service.sendSignal('OFFER', 'peer', '{"sdp":"offer"}');
    assert.deepEqual(JSON.parse(socket.sent[1]), {
        type: 'OFFER',
        targetId: 'peer',
        payload: '{"sdp":"offer"}'
    });

    socket.readyState = 0;
    assert.throws(
        () => service.sendSignal('OFFER', 'peer', '{}'),
        /conexão com o servidor de sinalização não está aberta/
    );
    service.socket = null;
    assert.throws(
        () => service.sendSignal('OFFER', 'peer', '{}'),
        /conexão com o servidor de sinalização não está aberta/
    );
});

test('disconnect closes an active socket and does not close an already closing one', () => {
    const { service } = createService();
    const socket = openSocket(service);

    service.disconnect();
    assert.equal(service.intentionalDisconnect, true);
    assert.equal(socket.closeCalls, 1);

    service.disconnect();
    assert.equal(socket.closeCalls, 1);

    service.socket = null;
    service.disconnect();
});

test('dispatches JOINED and peer membership messages', async () => {
    const { handlers, service } = createService();
    const socket = openSocket(service);

    await socket.onmessage({
        data: JSON.stringify({ type: 'ROOM_JOINED', senderId: 'me', peers: [] })
    });
    await service.handleMessage({ type: 'PEER_JOINED', senderId: 'peer-a' });
    await service.handleMessage({ type: 'PEER_LEFT', senderId: 'peer-b' });
    await service.handleMessage({ type: 'UNKNOWN' });

    assert.deepEqual(handlers.onJoined.calls, [[{ type: 'ROOM_JOINED', senderId: 'me', peers: [] }]]);
    assert.deepEqual(handlers.onPeerJoined.calls, [['peer-a']]);
    assert.deepEqual(handlers.onPeerLeft.calls, [['peer-b']]);
});

test('parses and dispatches all WebRTC signaling message types', async () => {
    const { handlers, service } = createService();

    await service.handleMessage({ type: 'OFFER', senderId: 'a', payload: '{"sdp":"offer"}' });
    await service.handleMessage({ type: 'ANSWER', senderId: 'b', payload: '{"sdp":"answer"}' });
    await service.handleMessage({ type: 'CANDIDATE', senderId: 'c', payload: '{"candidate":"ice"}' });

    assert.deepEqual(handlers.onOffer.calls, [['a', { sdp: 'offer' }]]);
    assert.deepEqual(handlers.onAnswer.calls, [['b', { sdp: 'answer' }]]);
    assert.deepEqual(handlers.onCandidate.calls, [['c', { candidate: 'ice' }]]);
});

test('reports malformed signaling payloads and handler failures', async () => {
    const { handlers, service } = createService();
    const socket = openSocket(service);

    await socket.onmessage({ data: '{' });
    assert.equal(handlers.onMessageError.calls.length, 1);

    handlers.onOffer = async () => {
        throw new Error('offer handler failed');
    };
    await socket.onmessage({ data: JSON.stringify({ type: 'OFFER', senderId: 'peer', payload: '{}' }) });
    assert.equal(handlers.onMessageError.calls.length, 2);
    assert.match(handlers.onMessageError.calls[1][0].message, /offer handler failed/);
});

test('reports signaling errors and closes after an ERROR message', async () => {
    const { handlers, service } = createService();
    const socket = openSocket(service);

    await service.handleMessage({ type: 'ERROR', payload: 'Senha incorreta!' });
    assert.deepEqual(handlers.onConnectionError.calls, [['Senha incorreta!']]);
    assert.equal(service.intentionalDisconnect, true);
    assert.equal(socket.closeCalls, 1);

    const fallback = createService();
    const fallbackSocket = openSocket(fallback.service);
    await fallback.service.handleMessage({ type: 'ERROR', payload: '' });
    assert.deepEqual(fallback.handlers.onConnectionError.calls, [['Erro ao entrar na sala.']]);
    assert.equal(fallbackSocket.closeCalls, 1);
});

test('reports each connection failure only once across error and close events', () => {
    const { handlers, service } = createService();
    const socket = openSocket(service);

    socket.onerror();
    socket.onclose();
    service.reportConnectionError('another error');

    assert.deepEqual(handlers.onConnectionError.calls, [['Erro de conexão com o servidor.']]);
});

test('reports an unexpected close but ignores intentional and already-reported closes', () => {
    const unexpected = createService();
    const unexpectedSocket = openSocket(unexpected.service);
    unexpectedSocket.onclose();
    assert.deepEqual(unexpected.handlers.onConnectionError.calls, [
        ['Conexão com o servidor encerrada.']
    ]);

    const intentional = createService();
    const intentionalSocket = openSocket(intentional.service);
    intentional.service.disconnect();
    intentionalSocket.onclose();
    assert.equal(intentional.handlers.onConnectionError.calls.length, 0);

    const errored = createService();
    const erroredSocket = openSocket(errored.service);
    erroredSocket.onerror();
    erroredSocket.onclose();
    assert.deepEqual(errored.handlers.onConnectionError.calls, [
        ['Erro de conexão com o servidor.']
    ]);
});
