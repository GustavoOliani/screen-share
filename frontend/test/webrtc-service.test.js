const assert = require('node:assert/strict');
const { test } = require('node:test');

globalThis.window = {};
require('../pages/room/webrtc-service.js');
const WebRtcService = globalThis.window.WebRtcService;

function spy(implementation = () => {}) {
    const calls = [];
    const fn = (...args) => {
        calls.push(args);
        return implementation(...args);
    };
    fn.calls = calls;
    return fn;
}

class FakeTrack {
    constructor(id, kind = 'video') {
        this.id = id;
        this.kind = kind;
        this.listeners = new Map();
        this.stopCalls = 0;
    }

    addEventListener(type, listener, options) {
        this.listeners.set(type, { listener, options });
    }

    end() {
        this.listeners.get('ended')?.listener();
    }

    stop() {
        this.stopCalls += 1;
    }
}

class FakeStream {
    constructor(tracks) {
        this.tracks = tracks;
    }

    getTracks() {
        return this.tracks;
    }

    getVideoTracks() {
        return this.tracks.filter(track => track.kind === 'video');
    }
}

function createHarness() {
    const peerConnections = [];
    const warnings = [];
    const errors = [];
    const navigator = {
        mediaDevices: {
            getDisplayMedia: async () => new FakeStream([new FakeTrack('captured-video')])
        }
    };

    class FakePeerConnection {
        constructor(configuration) {
            this.configuration = configuration;
            this.senders = [];
            this.signalingState = 'stable';
            this.iceConnectionState = 'new';
            this.localDescription = null;
            this.remoteDescription = null;
            this.restartIceCalls = 0;
            this.closeCalls = 0;
            this.removeTrackCalls = 0;
            this.addIceCandidateCalls = [];
            this.stats = new Map();
            this.setRemoteDescriptionError = null;
            this.setLocalDescriptionError = null;
            this.addIceCandidateError = null;
            this.getStatsError = null;
            this.transceivers = [];
            peerConnections.push(this);
        }

        addTrack(track, stream) {
            const sender = {
                track,
                stream,
                replacements: [],
                replaceTrackError: null,
                replaceTrack: async (newTrack) => {
                    if (sender.replaceTrackError) throw sender.replaceTrackError;
                    sender.replacements.push(newTrack);
                    sender.track = newTrack;
                }
            };
            this.senders.push(sender);
            this.transceivers.push({
                sender,
                receiver: { track: new FakeTrack(`remote-${track.kind}`, track.kind) },
                codecPreferences: null,
                setCodecPreferences(codecs) {
                    if (this.codecPreferencesError) throw this.codecPreferencesError;
                    this.codecPreferences = codecs;
                }
            });
            return sender;
        }

        getSenders() {
            return this.senders;
        }

        getTransceivers() {
            return this.transceivers;
        }

        removeTrack() {
            this.removeTrackCalls += 1;
        }

        async setLocalDescription() {
            if (this.setLocalDescriptionError) throw this.setLocalDescriptionError;
            const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
            this.localDescription = { type, sdp: `local-${type}` };
            this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
        }

        async setRemoteDescription(description) {
            if (this.setRemoteDescriptionError) throw this.setRemoteDescriptionError;
            this.remoteDescription = description;
            this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
        }

        async addIceCandidate(candidate) {
            if (this.addIceCandidateError) throw this.addIceCandidateError;
            this.addIceCandidateCalls.push(candidate);
        }

        restartIce() {
            this.restartIceCalls += 1;
        }

        async getStats() {
            if (this.getStatsError) throw this.getStatsError;
            return this.stats;
        }

        close() {
            this.closeCalls += 1;
        }
    }

    class FakeSender {
        static getCapabilities = () => ({
            codecs: [
                { mimeType: 'video/VP8', preferredPayloadType: 96 },
                { mimeType: 'video/rtx', sdpFmtpLine: 'apt=96' },
                { mimeType: 'video/H264', preferredPayloadType: 102 },
                { mimeType: 'video/rtx', sdpFmtpLine: 'apt=102' },
                { mimeType: 'audio/opus' }
            ]
        });
    }

    globalThis.RTCPeerConnection = FakePeerConnection;
    globalThis.RTCIceCandidate = class { constructor(value) { Object.assign(this, value); } };
    globalThis.RTCSessionDescription = class { constructor(value) { Object.assign(this, value); } };
    globalThis.RTCRtpSender = FakeSender;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator });
    console.error = (...args) => errors.push(args);
    console.warn = (...args) => warnings.push(args);

    const handlers = Object.fromEntries([
        'onError',
        'onIceConnectionState',
        'onLocalScreenShareEnded',
        'onLocalScreenShareStarted',
        'onRemoteStream',
        'onRemoteStreamEnded',
        'onVideoCodec'
    ].map(name => [name, spy()]));
    const sentSignals = [];
    const service = new WebRtcService({
        sendSignal: (...args) => sentSignals.push(args),
        handlers,
        iceServers: [{ urls: 'stun:test' }]
    });
    service.setLocalParticipantId('local');

    return { FakePeerConnection, FakeSender, FakeStream, FakeTrack, errors, handlers, navigator, peerConnections, sentSignals, service, warnings };
}

test('shares, ends a closed source, then reuses senders to share again', async () => {
    const { handlers, navigator, peerConnections, service } = createHarness();
    service.setLocalParticipantId('alice');
    const peerConnection = service.addPeer('bob');
    const firstStream = new FakeStream([new FakeTrack('video-1'), new FakeTrack('audio-1', 'audio')]);
    const secondStream = new FakeStream([new FakeTrack('video-2'), new FakeTrack('audio-2', 'audio')]);
    const streams = [firstStream, secondStream];
    let captureRequests = 0;
    navigator.mediaDevices.getDisplayMedia = async () => {
        captureRequests += 1;
        return streams.shift();
    };

    await service.toggleScreenShare({ width: 1920, height: 1080, frameRate: 30 });
    const originalSenders = [...peerConnection.getSenders()];
    assert.equal(peerConnection.getSenders().length, 2);
    assert.equal(handlers.onLocalScreenShareStarted.calls.length, 1);

    let finishTrackReplacement;
    const replacementGate = new Promise(resolve => { finishTrackReplacement = resolve; });
    const replaceVideoTrack = originalSenders[0].replaceTrack;
    originalSenders[0].replaceTrack = async track => {
        if (track === null) await replacementGate;
        await replaceVideoTrack(track);
    };
    firstStream.getVideoTracks()[0].end();
    const restart = service.toggleScreenShare({ width: 1280, height: 720, frameRate: 15 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(captureRequests, 1);
    finishTrackReplacement();
    await restart;

    assert.equal(service.localStream, secondStream);
    assert.equal(firstStream.getTracks().every(track => track.stopCalls === 1), true);
    assert.deepEqual(originalSenders.map(sender => sender.replacements.length), [2, 2]);
    assert.equal(peerConnection.removeTrackCalls, 0);
    assert.equal(handlers.onLocalScreenShareEnded.calls.length, 1);

    assert.equal(peerConnection.getSenders().length, 2);
    assert.deepEqual(peerConnection.getSenders(), originalSenders);
    assert.equal(peerConnection.getSenders().every(sender => sender.track !== null), true);
    assert.equal(handlers.onLocalScreenShareStarted.calls.length, 2);
    assert.equal(handlers.onLocalScreenShareEnded.calls.length, 1);
    assert.equal(peerConnections.length, 1);
});

test('starts with an active peer, stops on button toggle, and safely ignores a second stop', async () => {
    const { navigator, handlers, service } = createHarness();
    const stream = new FakeStream([new FakeTrack('video')]);
    navigator.mediaDevices.getDisplayMedia = async () => stream;

    await service.toggleScreenShare({ width: 1280, height: 720, frameRate: 30 });
    await service.toggleScreenShare({ width: 1280, height: 720, frameRate: 30 });
    await service.stopScreenShare();

    assert.equal(service.localStream, null);
    assert.equal(stream.getTracks()[0].stopCalls, 1);
    assert.equal(handlers.onLocalScreenShareEnded.calls.length, 1);
});

test('stops tracks even when a sender no longer owns that track', async () => {
    const { handlers, navigator, service } = createHarness();
    service.setLocalParticipantId('alice');
    const peerConnection = service.addPeer('bob');
    const stream = new FakeStream([new FakeTrack('video')]);
    navigator.mediaDevices.getDisplayMedia = async () => stream;
    await service.toggleScreenShare({ width: 1920, height: 1080, frameRate: 30 });
    peerConnection.getSenders()[0].track = new FakeTrack('replacement');

    await service.stopScreenShare();

    assert.equal(stream.getTracks()[0].stopCalls, 1);
    assert.equal(peerConnection.getSenders()[0].replacements.length, 0);
    assert.equal(handlers.onLocalScreenShareEnded.calls.length, 1);
});

test('reports capture rejection without leaving a stale stream', async () => {
    const { navigator, handlers, service } = createHarness();
    navigator.mediaDevices.getDisplayMedia = async () => {
        throw new Error('permission denied');
    };

    await service.toggleScreenShare({ width: 1920, height: 1080, frameRate: 30 });

    assert.equal(service.localStream, null);
    assert.equal(handlers.onError.calls.length, 1);
    assert.match(handlers.onError.calls[0][0], /iniciar o compartilhamento/);
    assert.equal(handlers.onLocalScreenShareEnded.calls.length, 0);
});

test('rejects a capture without video and stops its returned tracks', async () => {
    const { navigator, handlers, service } = createHarness();
    const audioTrack = new FakeTrack('audio', 'audio');
    const stream = new FakeStream([audioTrack]);
    navigator.mediaDevices.getDisplayMedia = async () => stream;

    await service.toggleScreenShare({ width: 1920, height: 1080, frameRate: 30 });

    assert.equal(service.localStream, null);
    assert.equal(audioTrack.stopCalls, 1);
    assert.equal(handlers.onError.calls.length, 1);
});

test('reports sender replacement failures but still cleans up the capture', async () => {
    const { handlers, navigator, service } = createHarness();
    service.setLocalParticipantId('alice');
    const peerConnection = service.addPeer('bob');
    const stream = new FakeStream([new FakeTrack('video')]);
    navigator.mediaDevices.getDisplayMedia = async () => stream;
    await service.toggleScreenShare({ width: 1920, height: 1080, frameRate: 30 });
    peerConnection.getSenders()[0].replaceTrackError = new Error('replace failed');

    await service.stopScreenShare();

    assert.equal(stream.getTracks()[0].stopCalls, 1);
    assert.equal(handlers.onError.calls.length, 1);
    assert.match(handlers.onError.calls[0][0], /encerrar uma faixa/);
    assert.equal(handlers.onLocalScreenShareEnded.calls.length, 1);
});

test('adds a peer only once and sends ICE candidates when present', () => {
    const { service, sentSignals } = createHarness();
    service.setLocalParticipantId('alice');
    const peerConnection = service.addPeer('bob');

    assert.equal(service.addPeer('bob'), peerConnection);
    peerConnection.onicecandidate({ candidate: { candidate: 'candidate' } });
    peerConnection.onicecandidate({ candidate: null });
    assert.equal(sentSignals.length, 1);
    assert.equal(sentSignals[0][0], 'CANDIDATE');
});

test('reports failure when adding current local tracks to a newly joined peer fails', async () => {
    const { FakePeerConnection, handlers, navigator, service } = createHarness();
    navigator.mediaDevices.getDisplayMedia = async () => new FakeStream([new FakeTrack('video')]);
    await service.toggleScreenShare({ width: 1920, height: 1080, frameRate: 30 });
    FakePeerConnection.prototype.addTrack = () => {
        throw new Error('sender unavailable');
    };

    service.addPeer('bob');
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(handlers.onError.calls.length, 1);
    assert.match(handlers.onError.calls[0][0], /faixas locais/);
});

test('reports an ICE send failure', () => {
    const { handlers, service } = createHarness();
    service.sendSignal = () => { throw new Error('socket closed'); };
    const peerConnection = service.addPeer('bob');

    peerConnection.onicecandidate({ candidate: { candidate: 'candidate' } });

    assert.equal(handlers.onError.calls.length, 1);
    assert.match(handlers.onError.calls[0][0], /candidato ICE/);
});

test('forwards remote streams and reports ended remote video tracks', () => {
    const { handlers, service } = createHarness();
    const peerConnection = service.addPeer('bob');
    const stream = new FakeStream([]);
    const videoTrack = new FakeTrack('remote-video');

    peerConnection.ontrack({ streams: [stream], track: videoTrack });
    videoTrack.end();
    peerConnection.ontrack({ streams: [], track: new FakeTrack('remote-audio', 'audio') });

    assert.deepEqual(handlers.onRemoteStream.calls, [['bob', stream]]);
    assert.deepEqual(handlers.onRemoteStreamEnded.calls, [['bob']]);
});

test('creates an offer after negotiation and reports failures', async () => {
    const { handlers, sentSignals, service } = createHarness();
    const successfulConnection = service.addPeer('bob');
    await successfulConnection.onnegotiationneeded();
    assert.equal(sentSignals[0][0], 'OFFER');
    assert.equal(service.peerStates.get('bob').makingOffer, false);

    const failingConnection = service.addPeer('carol');
    failingConnection.setLocalDescriptionError = new Error('offer failed');
    await failingConnection.onnegotiationneeded();
    assert.equal(handlers.onError.calls.length, 1);
    assert.equal(service.peerStates.get('carol').makingOffer, false);
});

test('restarts failed ICE once until a connection succeeds', () => {
    const { handlers, service } = createHarness();
    const peerConnection = service.addPeer('bob');

    peerConnection.iceConnectionState = 'failed';
    peerConnection.oniceconnectionstatechange();
    peerConnection.oniceconnectionstatechange();
    assert.equal(peerConnection.restartIceCalls, 1);
    assert.deepEqual(handlers.onIceConnectionState.calls, [['bob', 'failed'], ['bob', 'failed']]);

    peerConnection.iceConnectionState = 'connected';
    peerConnection.oniceconnectionstatechange();
    assert.equal(service.peerStates.get('bob').restartAttempted, false);
    peerConnection.iceConnectionState = 'completed';
    peerConnection.oniceconnectionstatechange();
    peerConnection.iceConnectionState = 'disconnected';
    peerConnection.oniceconnectionstatechange();
    peerConnection.iceConnectionState = 'failed';
    peerConnection.oniceconnectionstatechange();
    assert.equal(peerConnection.restartIceCalls, 2);
    assert.deepEqual(handlers.onIceConnectionState.calls.slice(-2), [
        ['bob', 'completed'], ['bob', 'failed']
    ]);
});

test('ignores a colliding offer when this peer is impolite', async () => {
    const { sentSignals, service } = createHarness();
    service.setLocalParticipantId('alice');
    const peerConnection = service.addPeer('z-peer');
    peerConnection.signalingState = 'have-local-offer';
    service.peerStates.get('z-peer').makingOffer = true;

    await service.handleOffer('z-peer', { type: 'offer', sdp: 'remote' });

    assert.equal(service.peerStates.get('z-peer').ignoreOffer, true);
    assert.equal(peerConnection.remoteDescription, null);
    assert.equal(sentSignals.length, 0);
});

test('accepts a colliding offer when this peer is polite and answers it', async () => {
    const { sentSignals, service } = createHarness();
    service.setLocalParticipantId('z-peer');
    const peerConnection = service.addPeer('alice');
    peerConnection.signalingState = 'have-local-offer';
    const state = service.peerStates.get('alice');
    state.makingOffer = true;
    state.pendingCandidates.push({ candidate: 'queued' });

    await service.handleOffer('alice', { type: 'offer', sdp: 'remote' });

    assert.equal(peerConnection.remoteDescription.sdp, 'remote');
    assert.equal(peerConnection.addIceCandidateCalls.length, 1);
    assert.equal(sentSignals[0][0], 'ANSWER');
    assert.equal(state.settingRemoteDescription, false);
    assert.equal(state.isSettingRemoteAnswerPending, false);
});

test('allows an offer while a remote answer is pending', async () => {
    const { sentSignals, service } = createHarness();
    const peerConnection = service.addPeer('bob');
    const state = service.peerStates.get('bob');
    peerConnection.signalingState = 'have-local-offer';
    state.isSettingRemoteAnswerPending = true;

    await service.handleOffer('bob', { type: 'offer', sdp: 'remote-offer' });

    assert.equal(peerConnection.remoteDescription.sdp, 'remote-offer');
    assert.equal(sentSignals[0][0], 'ANSWER');
});

test('answers an offer without a collision and ignores non-offer answers', async () => {
    const { sentSignals, service } = createHarness();

    await service.handleOffer('bob', { type: 'offer', sdp: 'remote-offer' });
    await service.handleOffer('bob', { type: 'pranswer', sdp: 'provisional' });

    assert.equal(sentSignals.length, 1);
    assert.equal(sentSignals[0][0], 'ANSWER');
    assert.equal(service.peerConnections.get('bob').remoteDescription.type, 'pranswer');
});

test('handles remote answers through handleOffer without creating an answer', async () => {
    const { sentSignals, service } = createHarness();
    service.setLocalParticipantId('alice');

    await service.handleOffer('bob', { type: 'answer', sdp: 'answer' });

    assert.equal(sentSignals.length, 0);
    assert.equal(service.peerStates.get('bob').settingRemoteDescription, false);
});

test('clears offer state and reports remote-description and candidate errors', async () => {
    const { handlers, service } = createHarness();
    const peerConnection = service.addPeer('bob');
    peerConnection.setRemoteDescriptionError = new Error('remote description failed');

    await service.handleOffer('bob', { type: 'offer', sdp: 'bad' });

    assert.equal(service.peerStates.get('bob').settingRemoteDescription, false);
    assert.equal(handlers.onError.calls.length, 1);

    peerConnection.setRemoteDescriptionError = null;
    peerConnection.remoteDescription = { type: 'offer' };
    peerConnection.addIceCandidateError = new Error('candidate failed');
    await service.handleCandidate('bob', { candidate: 'bad' });
    assert.equal(handlers.onError.calls.length, 2);

    service.peerStates.get('bob').ignoreOffer = true;
    await service.handleCandidate('bob', { candidate: 'ignored' });
    assert.equal(handlers.onError.calls.length, 2);
});

test('queues candidates before remote description and ignores unknown peers', async () => {
    const { service } = createHarness();
    await service.handleAnswer('missing', { type: 'answer' });
    await service.handleCandidate('missing', { candidate: 'candidate' });

    const peerConnection = service.addPeer('bob');
    const state = service.peerStates.get('bob');
    await service.handleCandidate('bob', { candidate: 'early' });
    assert.equal(state.pendingCandidates.length, 1);
    state.settingRemoteDescription = true;
    peerConnection.remoteDescription = { type: 'offer' };
    await service.handleCandidate('bob', { candidate: 'during-set' });
    assert.equal(state.pendingCandidates.length, 2);
});

test('adds a candidate immediately when a remote description is ready', async () => {
    const { service } = createHarness();
    const peerConnection = service.addPeer('bob');
    peerConnection.remoteDescription = { type: 'offer' };

    await service.handleCandidate('bob', { candidate: 'ready' });

    assert.equal(peerConnection.addIceCandidateCalls.length, 1);
    assert.equal(peerConnection.addIceCandidateCalls[0].candidate, 'ready');
});

test('accepts answers and applies queued ICE candidates', async () => {
    const { service } = createHarness();
    const peerConnection = service.addPeer('bob');
    const state = service.peerStates.get('bob');
    state.pendingCandidates.push({ candidate: 'early' });

    await service.handleAnswer('bob', { type: 'answer', sdp: 'remote-answer' });

    assert.equal(peerConnection.remoteDescription.sdp, 'remote-answer');
    assert.equal(peerConnection.addIceCandidateCalls.length, 1);
    assert.equal(state.settingRemoteDescription, false);
    assert.equal(state.isSettingRemoteAnswerPending, false);
});

test('reports answer failures and resets answer state', async () => {
    const { handlers, service } = createHarness();
    const peerConnection = service.addPeer('bob');
    peerConnection.setRemoteDescriptionError = new Error('answer failed');

    await service.handleAnswer('bob', { type: 'answer' });

    assert.equal(service.peerStates.get('bob').settingRemoteDescription, false);
    assert.equal(service.peerStates.get('bob').isSettingRemoteAnswerPending, false);
    assert.equal(handlers.onError.calls.length, 1);
});

test('reports queued candidate failures unless the offer was ignored', async () => {
    const { handlers, service } = createHarness();
    const peerConnection = service.addPeer('bob');
    peerConnection.addIceCandidateError = new Error('candidate failed');
    const state = service.peerStates.get('bob');
    state.pendingCandidates.push({ candidate: 'bad' });

    await assert.rejects(service.applyPendingCandidates(peerConnection, state), /candidate failed/);
    assert.equal(handlers.onError.calls.length, 0);

    state.ignoreOffer = true;
    state.pendingCandidates.push({ candidate: 'ignored' });
    await service.applyPendingCandidates(peerConnection, state);
});

test('removes a peer and safely handles unknown peers', () => {
    const { handlers, service } = createHarness();
    const peerConnection = service.addPeer('bob');

    service.removePeer('bob');
    service.removePeer('missing');

    assert.equal(peerConnection.closeCalls, 1);
    assert.equal(service.peerConnections.has('bob'), false);
    assert.equal(service.peerStates.has('bob'), false);
    assert.deepEqual(handlers.onVideoCodec.calls, [['bob', null], ['missing', null]]);
});

test('disposes all connections and clears an active screen share', async () => {
    const { handlers, navigator, peerConnections, service } = createHarness();
    service.setLocalParticipantId('alice');
    const peerConnection = service.addPeer('bob');
    const stream = new FakeStream([new FakeTrack('video')]);
    navigator.mediaDevices.getDisplayMedia = async () => stream;
    await service.toggleScreenShare({ width: 1920, height: 1080, frameRate: 30 });

    service.dispose();
    await service.pendingScreenShareStop;

    assert.equal(peerConnection.closeCalls, 1);
    assert.equal(service.peerConnections.size, 0);
    assert.equal(service.peerStates.size, 0);
    assert.equal(stream.getTracks()[0].stopCalls, 1);
    assert.equal(handlers.onLocalScreenShareEnded.calls.length, 1);
    assert.equal(peerConnections.length, 1);
});

test('prefers H264 and keeps matching RTX codecs adjacent', () => {
    const { service } = createHarness();
    const peerConnection = service.addPeer('bob');
    peerConnection.addTrack(new FakeTrack('video'), new FakeStream([]));

    service.applyVideoCodecPreferences(peerConnection);

    const codecs = peerConnection.transceivers[0].codecPreferences;
    assert.equal(JSON.stringify(codecs.map(codec => codec.mimeType)), JSON.stringify([
        'video/H264', 'video/rtx', 'video/VP8', 'video/rtx'
    ]));
});

test('skips codec preferences when capabilities, transceivers, or codecs are unavailable', () => {
    const { FakePeerConnection, FakeSender, service, warnings } = createHarness();
    const noTransceiver = new FakePeerConnection({});
    service.applyVideoCodecPreferences(noTransceiver);

    const unsupported = service.addPeer('bob');
    unsupported.addTrack(new FakeTrack('video'), new FakeStream([]));
    unsupported.transceivers[0].setCodecPreferences = undefined;
    service.applyVideoCodecPreferences(unsupported);
    assert.equal(warnings.length, 1);

    const noCodecs = new FakePeerConnection({});
    noCodecs.addTrack(new FakeTrack('video'), new FakeStream([]));
    FakeSender.getCapabilities = () => ({});
    service.applyVideoCodecPreferences(noCodecs);
    FakeSender.getCapabilities = undefined;
    service.applyVideoCodecPreferences(noCodecs);
});

test('handles unavailable capabilities and codec preference failures', () => {
    const { FakePeerConnection, FakeSender, service, warnings } = createHarness();
    const peerConnection = service.addPeer('bob');
    peerConnection.addTrack(new FakeTrack('video'), new FakeStream([]));

    peerConnection.transceivers[0].setCodecPreferences = function () {
        throw new Error('codec preference failed');
    };
    service.applyVideoCodecPreferences(peerConnection);
    assert.equal(warnings.length, 1);

    const noVideoCodec = new FakePeerConnection({});
    const sender = noVideoCodec.addTrack(new FakeTrack('video'), new FakeStream([]));
    FakeSender.getCapabilities = () => ({ codecs: [{ mimeType: 'audio/opus' }] });
    service.applyVideoCodecPreferences(noVideoCodec);
    assert.equal(sender.track.kind, 'video');
    assert.equal(warnings.length, 2);
});

test('handles codecs without payload metadata and missing codec fields', () => {
    const { FakePeerConnection, FakeSender, service } = createHarness();
    const peerConnection = new FakePeerConnection({});
    peerConnection.addTrack(new FakeTrack('video'), new FakeStream([]));
    FakeSender.getCapabilities = () => ({
        codecs: [
            {},
            { mimeType: 'video/AV1' },
            { mimeType: 'video/rtx' },
            { mimeType: 'video/H264', preferredPayloadType: 100 },
            { mimeType: 'video/rtx', sdpFmtpLine: 'apt=100' }
        ]
    });

    service.applyVideoCodecPreferences(peerConnection);

    assert.equal(peerConnection.transceivers[0].codecPreferences.length, 4);
});

test('updates codec from outbound reports first and tolerates missing or invalid reports', async () => {
    const { handlers, service } = createHarness();
    const peerConnection = service.addPeer('bob');
    peerConnection.stats = new Map([
        ['inbound-codec', { mimeType: 'video/VP8' }],
        ['outbound-codec', { mimeType: 'video/H264' }],
        ['outbound', { type: 'outbound-rtp', kind: 'video', codecId: 'outbound-codec' }],
        ['inbound', { type: 'inbound-rtp', mediaType: 'video', codecId: 'inbound-codec' }]
    ]);

    await service.updateVideoCodec('bob', peerConnection);
    assert.deepEqual(handlers.onVideoCodec.calls, [['bob', 'H264']]);

    peerConnection.stats = new Map([
        ['not-video', { mimeType: 'audio/opus' }],
        ['report', { type: 'outbound-rtp', mediaType: 'video', codecId: 'not-video' }],
        ['missing-codec', { type: 'inbound-rtp', kind: 'video', codecId: 'absent' }],
        ['missing-kind', { type: 'inbound-rtp', codecId: 'not-video' }],
        ['unsupported-type', { type: 'remote-inbound-rtp', kind: 'video', codecId: 'not-video' }]
    ]);
    await service.updateVideoCodec('bob', peerConnection);
    assert.equal(handlers.onVideoCodec.calls.length, 1);

    peerConnection.stats = new Map();
    await service.updateVideoCodec('bob', peerConnection);
    assert.equal(handlers.onVideoCodec.calls.length, 1);
});

test('logs stats lookup errors without interrupting the caller', async () => {
    const { warnings, service } = createHarness();
    const peerConnection = service.addPeer('bob');
    peerConnection.getStatsError = new Error('stats unavailable');

    await service.updateVideoCodec('bob', peerConnection);

    assert.equal(warnings.length, 1);
});

test('reports media errors to both the console and UI handler', () => {
    const { errors, handlers, service } = createHarness();
    const error = new Error('failure');

    service.reportError('Falha de mídia.', error);

    assert.deepEqual(handlers.onError.calls, [['Falha de mídia.']]);
    assert.equal(errors.length, 1);
});
