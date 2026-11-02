const { expect } = require('@playwright/test');

function installScreenCaptureSimulation() {
    const metrics = {
        addTrackCalls: 0,
        negotiationNeeded: 0,
        removeTrackCalls: 0,
        replaceTrackTargets: []
    };
    const captures = [];
    const NativePeerConnection = window.RTCPeerConnection;
    const nativeAddTrack = NativePeerConnection.prototype.addTrack;
    const nativeRemoveTrack = NativePeerConnection.prototype.removeTrack;

    NativePeerConnection.prototype.addTrack = function (...args) {
        const sender = nativeAddTrack.apply(this, args);
        metrics.addTrackCalls += 1;
        const nativeReplaceTrack = sender.replaceTrack.bind(sender);
        sender.replaceTrack = track => {
            metrics.replaceTrackTargets.push(track ? track.id : null);
            return nativeReplaceTrack(track);
        };
        return sender;
    };

    NativePeerConnection.prototype.removeTrack = function (...args) {
        metrics.removeTrackCalls += 1;
        return nativeRemoveTrack.apply(this, args);
    };

    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
        construct(target, args, newTarget) {
            const peerConnection = Reflect.construct(target, args, newTarget);
            peerConnection.addEventListener('negotiationneeded', () => {
                metrics.negotiationNeeded += 1;
            });
            return peerConnection;
        }
    });

    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: async () => {
            const captureNumber = captures.length + 1;
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 180;
            const context = canvas.getContext('2d');
            const color = captureNumber === 1 ? '#f00a14' : '#0a14f0';
            let frame = 0;
            const drawFrame = () => {
                context.fillStyle = color;
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.fillStyle = '#ffffff';
                context.fillText(`Capture ${captureNumber}, frame ${frame++}`, 8, 18);
            };
            drawFrame();
            const timer = setInterval(drawFrame, 50);
            const stream = canvas.captureStream(15);
            const track = stream.getVideoTracks()[0];
            track.addEventListener('ended', () => clearInterval(timer), { once: true });
            captures.push({ stream, track });
            return stream;
        }
    });

    window.__screenShareE2E = {
        captures,
        metrics,
        simulateWindowClosed() {
            const capture = captures.at(-1);
            if (!capture) throw new Error('No simulated screen capture is active.');
            capture.track.dispatchEvent(new Event('ended'));
        }
    };
}

class RoomPage {
    constructor(page) {
        this.page = page;
        this.shareButton = page.locator('#share-btn');
        this.connectionStatus = page.locator('#connection-status');
        this.participantsHeading = page.locator('#participants-heading');
        this.localScreenTile = page.locator('#card-__local-screen__');
        this.resolutionSelect = page.locator('#resolution-select');
        this.frameRateSelect = page.locator('#frame-rate-select');
    }

    async installScreenCaptureSimulation() {
        await this.page.addInitScript(installScreenCaptureSimulation);
    }

    async join(baseUrl, password) {
        await this.page.goto(baseUrl);
        await this.page.locator('#room-password').fill(password);
        await this.page.getByRole('button', { name: 'Entrar na Sala' }).click();
        await expect(this.connectionStatus).toHaveText('Conectado', { timeout: 20_000 });
    }

    async expectParticipantCount(count) {
        await expect(this.participantsHeading).toHaveText(`Na sala (${count})`);
    }

    async startScreenShare() {
        await this.shareButton.click();
        await expect(this.shareButton).toHaveText('Parar Compartilhamento');
        await expect(this.localScreenTile).toBeVisible();
        await expect(this.resolutionSelect).toBeDisabled();
        await expect(this.frameRateSelect).toBeDisabled();
    }

    async closeCapturedWindow() {
        await this.page.evaluate(() => window.__screenShareE2E.simulateWindowClosed());
    }

    async expectScreenShareStopped() {
        await expect(this.shareButton).toHaveText('Compartilhar Tela');
        await expect(this.localScreenTile).toHaveCount(0);
        await expect(this.resolutionSelect).toBeEnabled();
        await expect(this.frameRateSelect).toBeEnabled();
        await expect(this.connectionStatus).toHaveText('Conectado');
    }

    async expectRemoteScreenColor(color) {
        await this.page.waitForFunction(expectedColor => {
            const tile = [...document.querySelectorAll('.video-tile')]
                .find(candidate => candidate.textContent.includes('(Compartilhamento de tela)'));
            const video = tile?.querySelector('video');
            if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
                || video.videoWidth === 0 || video.videoHeight === 0) {
                return false;
            }

            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(video, 0, 0);
            const [red, green, blue] = context.getImageData(
                Math.floor(video.videoWidth / 2),
                Math.floor(video.videoHeight / 2),
                1,
                1
            ).data;
            return expectedColor === 'red'
                ? red > green * 2 && red > blue * 2
                : blue > red * 2 && blue > green * 2;
        }, color, { timeout: 30_000 });
    }

    async shareMetrics() {
        return this.page.evaluate(() => ({
            captureCount: window.__screenShareE2E.captures.length,
            ...window.__screenShareE2E.metrics
        }));
    }

    async expectReplacementTracks(targets) {
        await expect.poll(async () => (await this.shareMetrics()).replaceTrackTargets)
            .toEqual(targets);
    }

    async expectStillInRoom() {
        await expect(this.page).toHaveURL(/\/room\.html$/);
        await expect(this.connectionStatus).toHaveText('Conectado');
    }
}

module.exports = { RoomPage };
