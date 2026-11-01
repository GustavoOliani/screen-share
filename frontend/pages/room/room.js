let myId;
let hasConnectionError = false;
let mainVideoId;
const participantIds = new Set();
const connectionStatus = document.getElementById('connection-status');
const mainVideoContainer = document.getElementById('main-video-container');
const thumbnailStrip = document.getElementById('thumbnail-strip');
const participantsHeading = document.getElementById('participants-heading');
const placeholder = document.getElementById('placeholder-card');
const shareButton = document.getElementById('share-btn');
const localScreenId = '__local-screen__';
const mediaService = new window.WebRtcService({
    sendSignal: (...args) => roomService.sendSignal(...args),
    iceServers: window.SCREEN_SHARE_CONFIG?.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
    handlers: {
        onRemoteStream: addVideoTile,
        onRemoteStreamEnded: removeVideoTile,
        onLocalScreenShareStarted: (stream) => {
            shareButton.innerText = 'Parar Compartilhamento';
            shareButton.className = 'btn-danger';
            addVideoTile(localScreenId, stream);
        },
        onLocalScreenShareEnded: () => {
            shareButton.innerText = 'Compartilhar Tela';
            shareButton.className = 'btn-success';
            removeVideoTile(localScreenId);
        },
        onIceConnectionState: handleIceConnectionState,
        onError: reportMediaError
    }
});
const roomService = new window.RoomService({
    onJoined: handleRoomJoined,
    onPeerJoined: handlePeerJoined,
    onPeerLeft: removePeer,
    onOffer: (peerId, offer) => mediaService.handleOffer(peerId, offer),
    onAnswer: (peerId, answer) => mediaService.handleAnswer(peerId, answer),
    onCandidate: (peerId, candidate) => mediaService.handleCandidate(peerId, candidate),
    onConnectionError: showConnectionError,
    onMessageError: (error) => reportMediaError(
        'Não foi possível processar uma mensagem de sinalização.',
        error)
});

function connect() {
    let roomConfig;
    try {
        roomConfig = JSON.parse(sessionStorage.getItem('screenShareConfig'));
    } catch (error) {
        showConnectionError('Não foi possível recuperar os dados de acesso.');
        return;
    }

    if (!roomConfig || !roomConfig.url || !roomConfig.password) {
        window.location.replace('index.html');
        return;
    }

    roomService.connect(roomConfig);
}

function showConnectionError(message) {
    hasConnectionError = true;
    connectionStatus.innerText = message;
    connectionStatus.classList.remove('connection-status-connected');
    connectionStatus.classList.add('connection-status-error');
    shareButton.disabled = true;
}

function handleRoomJoined(data) {
    myId = data.senderId;
    mediaService.setLocalParticipantId(myId);
    document.getElementById('user-id-display').innerText = `Seu ID: ${myId.slice(0, 8)}`;
    connectionStatus.innerText = 'Conectado';
    connectionStatus.classList.remove('connection-status-error');
    connectionStatus.classList.add('connection-status-connected');
    shareButton.disabled = false;

    participantIds.add(myId);
    for (const peer of data.peers || []) {
        const peerId = typeof peer === 'string' ? peer : peer.id;
        if (!peerId) continue;
        participantIds.add(peerId);
        mediaService.addPeer(peerId);
    }
    updateParticipantList();
}

function handlePeerJoined(peerId) {
    participantIds.add(peerId);
    updateParticipantList();
    console.log('Novo peer conectado:', peerId);
    mediaService.addPeer(peerId);
}

function reportMediaError(message, error) {
    console.error(message, error);
    connectionStatus.innerText = message;
    connectionStatus.classList.remove('connection-status-connected');
    connectionStatus.classList.add('connection-status-error');
}

function handleIceConnectionState(peerId, state) {
    if (state === 'failed') {
        reportMediaError(`Não foi possível conectar o vídeo com ${peerId.slice(0, 8)}.`, null);
    } else if (!hasConnectionError) {
        connectionStatus.innerText = 'Conectado';
        connectionStatus.classList.remove('connection-status-error');
        connectionStatus.classList.add('connection-status-connected');
    }
}

function addVideoTile(id, stream) {
    let card = document.getElementById(`card-${id}`);
    if (card) {
        card.querySelector('video').srcObject = stream;
        updateConnectionStatusVisibility();
        return;
    }

    const isLocalScreen = id === localScreenId;
    const displayName = isLocalScreen
        ? 'Sua tela'
        : `Participante ${id.slice(0, 8)} (Compartilhamento de tela)`;

    card = document.createElement('article');
    card.className = 'video-tile';
    card.id = `card-${id}`;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Exibir em tela principal: ${displayName}`);
    card.tabIndex = 0;
    card.addEventListener('click', () => setMainVideo(id));
    card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setMainVideo(id);
        }
    });

    const header = document.createElement('header');
    header.innerText = displayName;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocalScreen;
    video.srcObject = stream;

    card.appendChild(header);
    card.appendChild(video);

    if (!mainVideoId) {
        mainVideoId = id;
        card.classList.add('is-main');
        mainVideoContainer.appendChild(card);
        placeholder.hidden = true;
    } else {
        card.classList.add('is-thumbnail');
        thumbnailStrip.appendChild(card);
    }
    updateConnectionStatusVisibility();
}

function setMainVideo(id) {
    if (id === mainVideoId) return;

    const selectedCard = document.getElementById(`card-${id}`);
    if (!selectedCard) return;

    const currentMainCard = mainVideoId
        ? document.getElementById(`card-${mainVideoId}`)
        : null;
    if (currentMainCard) {
        currentMainCard.classList.remove('is-main');
        currentMainCard.classList.add('is-thumbnail');
        thumbnailStrip.appendChild(currentMainCard);
    }

    selectedCard.classList.remove('is-thumbnail');
    selectedCard.classList.add('is-main');
    mainVideoContainer.appendChild(selectedCard);
    mainVideoId = id;
    placeholder.hidden = true;
}

function removeVideoTile(id) {
    const card = document.getElementById(`card-${id}`);
    if (!card) return;

    const wasMainVideo = mainVideoId === id;
    card.remove();

    if (wasMainVideo) {
        mainVideoId = undefined;
        const nextThumbnail = thumbnailStrip.firstElementChild;
        if (nextThumbnail) {
            setMainVideo(nextThumbnail.id.substring('card-'.length));
        }
    }
    updateConnectionStatusVisibility();
    checkPlaceholder();
}

function removePeer(peerId) {
    mediaService.removePeer(peerId);
    participantIds.delete(peerId);
    updateParticipantList();
    removeVideoTile(peerId);
}

function updateParticipantList() {
    participantsHeading.innerText = `Na sala (${participantIds.size})`;
}

function updateConnectionStatusVisibility() {
    connectionStatus.hidden = Boolean(document.querySelector('.video-tile'));
}

function checkPlaceholder() {
    placeholder.hidden = Boolean(mainVideoId);
}

function leaveRoom() {
    mediaService.dispose();
    roomService.disconnect();
    sessionStorage.removeItem('screenShareConfig');
    window.location.assign('index.html');
}

shareButton.addEventListener('click', () => mediaService.toggleScreenShare());
document.querySelector('.btn-danger:last-child').addEventListener('click', leaveRoom);
connect();
