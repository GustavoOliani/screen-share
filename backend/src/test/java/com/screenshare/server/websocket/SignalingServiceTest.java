package com.screenshare.server.websocket;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.Arrays;
import java.util.Map;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SignalingServiceTest {

    private SignalingService signalingService;

    @BeforeEach
    void setUp() {
        signalingService = new SignalingService("secret");
    }

    @Test
    void joinsParticipantsAndForwardsSignalsToTheTarget() throws Exception {
        WebSocketSession alice = session("alice");
        WebSocketSession bob = session("bob");
        signalingService.registerSession(alice);
        signalingService.registerSession(bob);

        signalingService.handleMessage(alice, Map.of("type", "JOIN", "roomPassword", "secret"));
        signalingService.handleMessage(bob, Map.of("type", "JOIN", "roomPassword", "secret"));

        verify(alice).sendMessage(argThatTextContains("\"type\":\"ROOM_JOINED\""));
        verify(alice).sendMessage(argThatTextContains("\"type\":\"PEER_JOINED\""));
        verify(bob).sendMessage(argThatTextContains("\"peers\":[\"alice\"]"));

        signalingService.handleMessage(alice, Map.of(
                "type", "OFFER",
                "targetId", "bob",
                "payload", "{\"sdp\":\"offer\"}"));

        verify(bob).sendMessage(argThatTextContains(
                "\"type\":\"OFFER\"",
                "\"senderId\":\"alice\"",
                "\\\"sdp\\\":\\\"offer\\\""));
    }

    @Test
    void rejectsJoinWithAnIncorrectPassword() throws Exception {
        WebSocketSession participant = session("participant");
        signalingService.registerSession(participant);

        signalingService.handleMessage(participant, Map.of("type", "JOIN", "roomPassword", "wrong"));

        verify(participant).sendMessage(argThatTextContains("\"payload\":\"Senha incorreta!\""));
        verify(participant).close(CloseStatus.POLICY_VIOLATION);
    }

    @Test
    void rejectsSignalingBeforeJoiningTheRoom() throws Exception {
        WebSocketSession participant = session("participant");
        signalingService.registerSession(participant);

        signalingService.handleMessage(participant, Map.of(
                "type", "OFFER",
                "targetId", "other",
                "payload", "offer"));

        verify(participant).sendMessage(argThatTextContains(
                "\"payload\":\"Entre na sala antes de enviar sinalização.\""));
        verify(participant).close(CloseStatus.POLICY_VIOLATION);
    }

    @Test
    void notifiesRemainingParticipantsWhenSomeoneLeaves() throws Exception {
        WebSocketSession alice = session("alice");
        WebSocketSession bob = session("bob");
        signalingService.registerSession(alice);
        signalingService.registerSession(bob);
        signalingService.handleMessage(alice, Map.of("type", "JOIN", "roomPassword", "secret"));
        signalingService.handleMessage(bob, Map.of("type", "JOIN", "roomPassword", "secret"));

        signalingService.removeSession(bob);

        verify(alice).sendMessage(argThatTextContains(
                "\"type\":\"PEER_LEFT\"", "\"senderId\":\"bob\""));
    }

    private static WebSocketSession session(String id) {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn(id);
        when(session.isOpen()).thenReturn(true);
        return session;
    }

    private static TextMessage argThatTextContains(String... fragments) {
        return org.mockito.ArgumentMatchers.argThat((TextMessage message) ->
                message != null && Arrays.stream(fragments).allMatch(message.getPayload()::contains));
    }
}
