class WebRtcService {
    constructor({ sendSignal, handlers, iceServers }) {
        this.sendSignal = sendSignal;
        this.handlers = handlers;
        this.iceServers = iceServers;
        this.localId = null;
        this.localStream = null;
        this.pendingScreenShareStop = Promise.resolve();
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
            pendingCandidates: [],
            localSenders: new Map()
        };
        this.peerConnections.set(peerId, peerConnection);
        this.peerStates.set(peerId, state);

        if (this.localStream) {
            void this.addLocalTracks(peerConnection, this.localStream, state)
                .catch(error => this.reportError('Não foi possível adicionar as faixas locais.', error));
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
                void this.updateVideoCodec(peerId, peerConnection);
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
            this.applyVideoCodecPreferences(peerConnection);
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

    async toggleScreenShare({ width, height, frameRate }) {
        if (this.localStream) {
            await this.stopScreenShare();
            return;
        }

        try {
            await this.pendingScreenShareStop;
            this.localStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    width: { ideal: width },
                    height: { ideal: height },
                    frameRate: { ideal: frameRate }
                },
                audio: true
            });
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (!videoTrack) {
                throw new Error('A captura de tela não retornou uma faixa de vídeo.');
            }

            await Promise.all([...this.peerConnections.entries()].map(([peerId, peerConnection]) =>
                this.addLocalTracks(peerConnection, this.localStream, this.peerStates.get(peerId))));
            videoTrack.addEventListener('ended', () => {
                void this.stopScreenShare();
            }, { once: true });
            this.handlers.onLocalScreenShareStarted(this.localStream);
        } catch (error) {
            this.reportError('Erro ao iniciar o compartilhamento de tela.', error);
            await this.stopScreenShare();
        }
    }

    async stopScreenShare() {
        if (!this.localStream) {
            await this.pendingScreenShareStop;
            return;
        }

        const stream = this.localStream;
        this.localStream = null;
        const stopPromise = (async () => {
            const replacements = [];
            for (const state of this.peerStates.values()) {
                for (const track of stream.getTracks()) {
                    const sender = state.localSenders.get(track.kind);
                    if (sender?.track === track) {
                        replacements.push(sender.replaceTrack(null));
                    }
                }
            }

            const results = await Promise.allSettled(replacements);
            for (const result of results) {
                if (result.status === 'rejected') {
                    this.reportError('Não foi possível encerrar uma faixa de compartilhamento.', result.reason);
                }
            }
            stream.getTracks().forEach(track => track.stop());
            this.handlers.onLocalScreenShareEnded();
        })();
        this.pendingScreenShareStop = stopPromise;
        try {
            await stopPromise;
        } finally {
            if (this.pendingScreenShareStop === stopPromise) {
                this.pendingScreenShareStop = Promise.resolve();
            }
        }
    }

    removePeer(peerId) {
        const peerConnection = this.peerConnections.get(peerId);
        if (peerConnection) {
            peerConnection.close();
            this.peerConnections.delete(peerId);
        }
        this.peerStates.delete(peerId);
        this.handlers.onVideoCodec(peerId, null);
    }

    dispose() {
        this.stopScreenShare();
        for (const peerConnection of this.peerConnections.values()) {
            peerConnection.close();
        }
        this.peerConnections.clear();
        this.peerStates.clear();
    }

    async addLocalTracks(peerConnection, stream, state) {
        for (const track of stream.getTracks()) {
            const sender = state.localSenders.get(track.kind);
            if (sender) {
                await sender.replaceTrack(track);
            } else {
                state.localSenders.set(track.kind, peerConnection.addTrack(track, stream));
            }
        }
        this.applyVideoCodecPreferences(peerConnection);
    }

    applyVideoCodecPreferences(peerConnection) {
        if (typeof RTCRtpSender.getCapabilities !== 'function') {
            return;
        }

        const transceivers = peerConnection.getTransceivers().filter(transceiver =>
            transceiver.sender.track?.kind === 'video'
                || transceiver.receiver.track?.kind === 'video');
        if (transceivers.length === 0) return;

        for (const transceiver of transceivers) {
            if (typeof transceiver.setCodecPreferences !== 'function') {
                console.warn('Preferência de codec não suportada; usando a negociação padrão do navegador.');
                return;
            }
        }

        const capabilities = RTCRtpSender.getCapabilities('video');
        if (!capabilities?.codecs) {
            return;
        }

        const videoCodecs = capabilities.codecs.filter(codec =>
            codec.mimeType?.toLowerCase().startsWith('video/')
                && codec.mimeType.toLowerCase() !== 'video/rtx');
        const preferredVideoCodecs = [
            ...videoCodecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264'),
            ...videoCodecs.filter(codec => codec.mimeType.toLowerCase() !== 'video/h264')
        ];
        if (preferredVideoCodecs.length === 0) {
            console.warn('Nenhum codec de vídeo anunciado pelo navegador; usando a negociação padrão.');
            return;
        }

        const preferredCodecs = [];
        for (const codec of preferredVideoCodecs) {
            preferredCodecs.push(codec);
            const payloadType = codec.preferredPayloadType;
            if (payloadType === undefined) continue;

            const rtxCodecs = capabilities.codecs.filter(candidate =>
                candidate.mimeType?.toLowerCase() === 'video/rtx'
                    && candidate.sdpFmtpLine?.match(/(?:^|;)\s*apt=(\d+)(?:;|$)/i)?.[1]
                    === String(payloadType));
            preferredCodecs.push(...rtxCodecs);
        }
        const includedCodecs = new Set(preferredCodecs);
        preferredCodecs.push(...capabilities.codecs.filter(codec =>
            codec.mimeType?.toLowerCase().startsWith('video/')
                && !includedCodecs.has(codec)));

        try {
            for (const transceiver of transceivers) {
                transceiver.setCodecPreferences(preferredCodecs);
            }
        } catch (error) {
            console.warn('Não foi possível aplicar preferências de codec; usando a negociação padrão.', error);
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

    async updateVideoCodec(peerId, peerConnection) {
        try {
            const stats = await peerConnection.getStats();
            const videoReports = [...stats.values()].filter(report =>
                ['outbound-rtp', 'inbound-rtp'].includes(report.type)
                    && (report.kind === 'video' || report.mediaType === 'video')
                    && report.codecId);
            videoReports.sort((first, second) =>
                Number(second.type === 'outbound-rtp') - Number(first.type === 'outbound-rtp'));
            for (const report of videoReports) {
                const codec = stats.get(report.codecId);
                if (codec?.mimeType?.startsWith('video/')) {
                    this.handlers.onVideoCodec(peerId, codec.mimeType.substring('video/'.length));
                    return;
                }
            }
        } catch (error) {
            console.warn(`Não foi possível consultar o codec de vídeo de ${peerId}.`, error);
        }
    }

    reportError(message, error) {
        console.error(message, error);
        this.handlers.onError(message);
    }
}

window.WebRtcService = WebRtcService;
