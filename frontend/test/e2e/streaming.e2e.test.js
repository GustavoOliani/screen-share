const assert = require('node:assert/strict');
const {
    after,
    afterEach,
    before,
    beforeEach,
    describe,
    test
} = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { RoomPage } = require('./pages/room-page');
const { startTestEnvironment, stopTestEnvironment } = require('./test-environment');

describe('Regras de negócio do compartilhamento de tela', { timeout: 120_000 }, () => {
    let browser;
    let environment;
    let hostContext;
    let viewerContext;
    let host;
    let viewer;
    let pageErrors;

    before(async () => {
        browser = await chromium.launch({
            channel: 'chrome',
            headless: true,
            args: ['--autoplay-policy=no-user-gesture-required']
        });
    });

    beforeEach(async () => {
        environment = await startTestEnvironment();
        hostContext = await browser.newContext();
        viewerContext = await browser.newContext();
        host = new RoomPage(await hostContext.newPage());
        viewer = new RoomPage(await viewerContext.newPage());
        pageErrors = [];
        await host.installScreenCaptureSimulation();
        await viewer.installScreenCaptureSimulation();
        host.page.on('pageerror', error => pageErrors.push(error.message));
        viewer.page.on('pageerror', error => pageErrors.push(error.message));
        await host.join(environment.baseUrl, environment.roomPassword);
        await viewer.join(environment.baseUrl, environment.roomPassword);
    });

    afterEach(async () => {
        await Promise.all([hostContext?.close(), viewerContext?.close()]);
        host = undefined;
        viewer = undefined;
        hostContext = undefined;
        viewerContext = undefined;
        await stopTestEnvironment(environment);
        environment = undefined;
    });

    after(async () => {
        await browser?.close();
    });

    test('Participantes autenticados veem as demais pessoas na mesma sala', async () => {
        await host.expectParticipantCount(2);
        await viewer.expectParticipantCount(2);
        assert.deepEqual(pageErrors, []);
    });

    test('O compartilhamento ativo entrega os quadros da tela ao participante remoto', async () => {
        await host.startScreenShare();
        await viewer.expectRemoteScreenColor('red');

        const metrics = await host.shareMetrics();
        assert.equal(metrics.addTrackCalls, 1);
        assert.equal(metrics.removeTrackCalls, 0);
        assert.ok(metrics.negotiationNeeded > 0);
        assert.deepEqual(pageErrors, []);
    });

    test('Fechar a janela compartilhada encerra a captura e restaura os controles', async () => {
        await host.startScreenShare();
        await viewer.expectRemoteScreenColor('red');

        await host.closeCapturedWindow();
        await host.expectScreenShareStopped();
        await host.expectReplacementTracks([null]);
        assert.deepEqual(pageErrors, []);
    });

    test('Após fechar a janela, é possível compartilhar outra sem sair da sala ou renegociar', async () => {
        await host.startScreenShare();
        await viewer.expectRemoteScreenColor('red');
        const initialMetrics = await host.shareMetrics();

        await host.closeCapturedWindow();
        await host.expectScreenShareStopped();
        await host.expectReplacementTracks([null]);
        await host.startScreenShare();
        await viewer.expectRemoteScreenColor('blue');
        await host.expectStillInRoom();

        const finalMetrics = await host.shareMetrics();
        assert.equal(finalMetrics.captureCount, 2);
        assert.equal(finalMetrics.addTrackCalls, 1);
        assert.equal(finalMetrics.removeTrackCalls, 0);
        assert.deepEqual(finalMetrics.replaceTrackTargets.slice(0, 1), [null]);
        assert.ok(finalMetrics.replaceTrackTargets[1]);
        assert.equal(finalMetrics.negotiationNeeded, initialMetrics.negotiationNeeded);
        assert.deepEqual(pageErrors, []);
    });
});
