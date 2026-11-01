let ws;
let myId;
let roomConfig;
let localStream;
let isSharing = false;
let intentionalLeave = false;
let hasConnectionError = false;
let mainVideoId;
const peerConnections = {};
const peerNames = {};
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const connectionStatus = document.getElementById('connection-status');
const mainVideoContainer = document.getElementById('main-video-container');
const thumbnailStrip = document.getElementById('thumbnail-strip');
const participantsHeading = document.getElementById('participants-heading');
const placeholder = document.getElementById('placeholder-card');
const localScreenId = '__local-screen__';

function connect() {
    try {
        roomConfig = JSON.parse(sessionStorage.getItem('screenShareConfig'));
    } catch (error) {
        showConnectionError('Não foi possível recuperar os dados de acesso.');
        return;
    }

    if (!roomConfig || !roomConfig.url || !roomConfig.password || !roomConfig.name) {
        window.location.replace('index.html');
        return;
    }

    try {
        ws = new WebSocket(roomConfig.url);
    } catch (error) {
        showConnectionError('URL do servidor inválida.');
        return;
    }

    ws.onopen = () => {
        ws.send(JSON.stringify({
            type: 'JOIN',
            roomPassword: roomConfig.password,
            displayName: roomConfig.name
        }));
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        await handleSignalMessage(data);
    };

    ws.onerror = () => {
        showConnectionError('Erro de conexão com o servidor.');
    };

    ws.onclose = () => {
        if (!intentionalLeave && !hasConnectionError) {
            showConnectionError('Conexão com o servidor encerrada.');
        }
    };
}

function showConnectionError(message) {
    hasConnectionError = true;
    connectionStatus.innerText = message;
    connectionStatus.classList.remove('connection-status-connected');
    connectionStatus.classList.add('connection-status-error');
    document.getElementById('share-btn').disabled = true;
}

async function handleSignalMessage(data) {
    switch (data.type) {
        case 'ROOM_JOINED':
            myId = data.senderId;
            document.getElementById('user-id-display').innerText = `${roomConfig.name}`;
            connectionStatus.innerText = 'Conectado';
            connectionStatus.classList.remove('connection-status-error');
            connectionStatus.classList.add('connection-status-connected');
            document.getElementById('share-btn').disabled = false;

            peerNames[myId] = roomConfig.name;
            for (const peer of data.peers || []) {
                peerNames[peer.id] = peer.displayName || 'Participante';
                createPeerConnection(peer.id, false);
            }
            updateParticipantList();
            break;

        case 'ERROR':
            showConnectionError(data.payload || 'Erro ao entrar na sala.');
            ws.close();
            break;

        case 'PEER_JOINED':
            peerNames[data.senderId] = data.displayName || 'Participante';
            updateParticipantList();
            console.log('Novo peer conectado:', data.senderId);
            createPeerConnection(data.senderId, true);
            break;

        case 'PEER_LEFT':
            console.log('Peer saiu:', data.senderId);
            removePeer(data.senderId);
            break;

        case 'OFFER':
            await handleOffer(data.senderId, JSON.parse(data.payload));
            break;

        case 'ANSWER':
            await handleAnswer(data.senderId, JSON.parse(data.payload));
            break;

        case 'CANDIDATE':
            await handleCandidate(data.senderId, JSON.parse(data.payload));
            break;
    }
}

function createPeerConnection(peerId, isInitiator) {
    if (peerConnections[peerId]) return peerConnections[peerId];

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[peerId] = pc;

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'CANDIDATE',
                targetId: peerId,
                payload: JSON.stringify(event.candidate)
            }));
        }
    };

    pc.ontrack = (event) => {
        addVideoTile(peerId, event.streams[0]);
    };

    if (isInitiator && localStream) {
        pc.createOffer().then(offer => {
            pc.setLocalDescription(offer);
            ws.send(JSON.stringify({
                type: 'OFFER',
                targetId: peerId,
                payload: JSON.stringify(offer)
            }));
        });
    }

    return pc;
}

async function handleOffer(peerId, offer) {
    const pc = createPeerConnection(peerId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({
        type: 'ANSWER',
        targetId: peerId,
        payload: JSON.stringify(answer)
    }));
}

async function handleAnswer(peerId, answer) {
    const pc = peerConnections[peerId];
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
}

async function handleCandidate(peerId, candidate) {
    const pc = peerConnections[peerId];
    if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
}

async function toggleShare() {
    const shareBtn = document.getElementById('share-btn');
    if (!isSharing) {
        try {
            localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            isSharing = true;
            shareBtn.innerText = 'Parar Compartilhamento';
            shareBtn.className = 'btn-danger';

            addVideoTile(localScreenId, localStream);

            for (const peerId in peerConnections) {
                const pc = peerConnections[peerId];
                localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({
                    type: 'OFFER',
                    targetId: peerId,
                    payload: JSON.stringify(offer)
                }));
            }

            localStream.getVideoTracks()[0].onended = () => {
                stopShare();
            };
        } catch (err) {
            console.error('Erro ao capturar tela:', err);
        }
    } else {
        stopShare();
    }
}

function stopShare() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    isSharing = false;
    const shareBtn = document.getElementById('share-btn');
    shareBtn.innerText = 'Compartilhar Tela';
    shareBtn.className = 'btn-success';
    removeVideoTile(localScreenId);
}

function addVideoTile(id, stream) {
    let card = document.getElementById(`card-${id}`);
    if (card) {
        card.querySelector('video').srcObject = stream;
        return;
    }

    const isLocalScreen = id === localScreenId;
    const displayName = isLocalScreen
        ? `${roomConfig.name} (Sua tela)`
        : `${peerNames[id] || 'Participante'} (Compartilhamento de tela)`;

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
    checkPlaceholder();
}

function removePeer(peerId) {
    if (peerConnections[peerId]) {
        peerConnections[peerId].close();
        delete peerConnections[peerId];
    }
    delete peerNames[peerId];
    updateParticipantList();
    removeVideoTile(peerId);
}

function updateParticipantList() {
    const participants = Object.values(peerNames);
    participantsHeading.innerText = `Na sala (${participants.length})`;
}

function checkPlaceholder() {
    placeholder.hidden = Boolean(mainVideoId);
}

function leaveRoom() {
    intentionalLeave = true;
    stopShare();
    for (const peerId in peerConnections) {
        peerConnections[peerId].close();
        delete peerConnections[peerId];
    }
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
    sessionStorage.removeItem('screenShareConfig');
    window.location.assign('index.html');
}

document.getElementById('share-btn').addEventListener('click', toggleShare);
document.querySelector('.btn-danger').addEventListener('click', leaveRoom);
connect();
