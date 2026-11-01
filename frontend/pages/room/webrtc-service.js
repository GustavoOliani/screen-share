class WebRtcService {
    constructor({ sendSignal, handlers, iceServers }) {
        this.sendSignal = sendSignal;
        this.handlers = handlers;
        this.iceServers = iceServers;
        this.localId = null;
        this.localStream = null;
        this.peerConnections = new Map();
        this.peerStates = new Map();
    }

    setLocalParticipantId(id) {
        this.localId = id;
    }

    addPeer(peerId) {
        if (this.peerConnections.has(peerId)) {
            return this.peerConnections.get(peerId);
        }

        const peerConnection = new RTCPeerConnection({
            iceServers: this.iceServers
        });
        const state = {
            polite: this.localId.localeCompare(peerId) > 0,
            makingOffer: false,
            ignoreOffer: false,
            isSettingRemoteAnswerPending: false,
            settingRemoteDescription: false,
            restartAttempted: false,
            pendingCandidates: []
        };
        this.peerConnections.set(peerId, peerConnection);
        this.peerStates.set(peerId, state);

        if (this.localStream) {
            this.addLocalTracks(peerConnection, this.localStream);
        }

        peerConnection.onicecandidate = (event) => {
            if (!event.candidate) return;
            try {
                this.sendSignal('CANDIDATE', peerId, JSON.stringify(event.candidate));
            } catch (error) {
                this.reportError('Não foi possível enviar um candidato ICE.', error);
            }
        };

        peerConnection.ontrack = (event) => {
            if (event.streams[0]) {
                this.handlers.onRemoteStream(peerId, event.streams[0]);
            }
            if (event.track.kind === 'video') {
                event.track.addEventListener(
                    'ended',
                    () => this.handlers.onRemoteStreamEnded(peerId),
                    { once: true });
            }
        };

        peerConnection.onnegotiationneeded = async () => {
            try {
                state.makingOffer = true;
                await peerConnection.setLocalDescription();
                this.sendSignal('OFFER', peerId, JSON.stringify(peerConnection.localDescription));
            } catch (error) {
                this.reportError(
                    `Não foi possível negociar o vídeo com ${peerId.slice(0, 8)}.`,
                    error);
            } finally {
                state.makingOffer = false;
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            if (peerConnection.iceConnectionState === 'failed') {
                if (!state.restartAttempted) {
                    state.restartAttempted = true;
                    peerConnection.restartIce();
                }
                this.handlers.onIceConnectionState(peerId, 'failed');
            } else if (['connected', 'completed'].includes(peerConnection.iceConnectionState)) {
                state.restartAttempted = false;
                this.handlers.onIceConnectionState(peerId, peerConnection.iceConnectionState);
            }
        };

        return peerConnection;
    }

    async handleOffer(peerId, offer) {
        const peerConnection = this.addPeer(peerId);
        const state = this.peerStates.get(peerId);
        const readyForOffer = !state.makingOffer
            && (peerConnection.signalingState === 'stable' || state.isSettingRemoteAnswerPending);
        const offerCollision = offer.type === 'offer' && !readyForOffer;
        state.ignoreOffer = !state.polite && offerCollision;
        if (state.ignoreOffer) return;

        try {
            state.settingRemoteDescription = true;
            state.isSettingRemoteAnswerPending = offer.type === 'answer';
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            state.isSettingRemoteAnswerPending = false;
            state.settingRemoteDescription = false;
            await this.applyPendingCandidates(peerConnection, state);

            if (offer.type === 'offer') {
                await peerConnection.setLocalDescription();
                this.sendSignal('ANSWER', peerId, JSON.stringify(peerConnection.localDescription));
            }
        } catch (error) {
            state.isSettingRemoteAnswerPending = false;
            state.settingRemoteDescription = false;
            this.reportError(`Falha ao negociar o vídeo com ${peerId.slice(0, 8)}.`, error);
        }
    }

    async handleAnswer(peerId, answer) {
        const peerConnection = this.peerConnections.get(peerId);
        const state = this.peerStates.get(peerId);
        if (!peerConnection || !state) return;

        try {
            state.settingRemoteDescription = true;
            state.isSettingRemoteAnswerPending = true;
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            state.isSettingRemoteAnswerPending = false;
            state.settingRemoteDescription = false;
            await this.applyPendingCandidates(peerConnection, state);
        } catch (error) {
            state.isSettingRemoteAnswerPending = false;
            state.settingRemoteDescription = false;
            this.reportError(`Falha ao aceitar a conexão de vídeo com ${peerId.slice(0, 8)}.`, error);
        }
    }

    async handleCandidate(peerId, candidate) {
        const peerConnection = this.peerConnections.get(peerId);
        const state = this.peerStates.get(peerId);
        if (!peerConnection || !state) return;

        if (!peerConnection.remoteDescription || state.settingRemoteDescription) {
            state.pendingCandidates.push(candidate);
            return;
        }

        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            if (!state.ignoreOffer) {
                this.reportError(`Falha ao adicionar candidato ICE de ${peerId.slice(0, 8)}.`, error);
            }
        }
    }

    async toggleScreenShare() {
        if (this.localStream) {
            this.stopScreenShare();
            return;
        }

        try {
            this.localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            for (const peerConnection of this.peerConnections.values()) {
                this.addLocalTracks(peerConnection, this.localStream);
            }

            const videoTrack = this.localStream.getVideoTracks()[0];
            if (!videoTrack) {
                throw new Error('A captura de tela não retornou uma faixa de vídeo.');
            }
            videoTrack.onended = () => this.stopScreenShare();
            this.handlers.onLocalScreenShareStarted(this.localStream);
        } catch (error) {
            this.reportError('Erro ao iniciar o compartilhamento de tela.', error);
            this.stopScreenShare();
        }
    }

    stopScreenShare() {
        if (!this.localStream) return;

        const stream = this.localStream;
        this.localStream = null;
        const trackIds = new Set(stream.getTracks().map(track => track.id));
        for (const peerConnection of this.peerConnections.values()) {
            for (const sender of peerConnection.getSenders()) {
                if (sender.track && trackIds.has(sender.track.id)) {
                    peerConnection.removeTrack(sender);
                }
            }
        }
        stream.getTracks().forEach(track => track.stop());
        this.handlers.onLocalScreenShareEnded();
    }

    removePeer(peerId) {
        const peerConnection = this.peerConnections.get(peerId);
        if (peerConnection) {
            peerConnection.close();
            this.peerConnections.delete(peerId);
        }
        this.peerStates.delete(peerId);
    }

    dispose() {
        this.stopScreenShare();
        for (const peerConnection of this.peerConnections.values()) {
            peerConnection.close();
        }
        this.peerConnections.clear();
        this.peerStates.clear();
    }

    addLocalTracks(peerConnection, stream) {
        const existingTrackIds = new Set(peerConnection.getSenders().map(sender => sender.track?.id));
        for (const track of stream.getTracks()) {
            if (!existingTrackIds.has(track.id)) {
                peerConnection.addTrack(track, stream);
            }
        }
    }

    async applyPendingCandidates(peerConnection, state) {
        while (state.pendingCandidates.length > 0) {
            const candidate = state.pendingCandidates.shift();
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
                if (!state.ignoreOffer) {
                    throw error;
                }
            }
        }
    }

    reportError(message, error) {
        console.error(message, error);
        this.handlers.onError(message);
    }
}

window.WebRtcService = WebRtcService;
