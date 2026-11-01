package com.screenshare.server.websocket;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.SessionLimitExceededException;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class SignalingService {

    private static final Logger logger = LoggerFactory.getLogger(SignalingService.class);
    private static final int SEND_TIME_LIMIT_MILLIS = 10_000;
    private static final int SEND_BUFFER_LIMIT_BYTES = 256 * 1024;
    private static final Set<String> SIGNAL_TYPES = Set.of("OFFER", "ANSWER", "CANDIDATE");

    private final String roomPassword;
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    private final Set<String> joinedParticipants = ConcurrentHashMap.newKeySet();
    private final ObjectMapper objectMapper = new ObjectMapper();

    public SignalingService(@Value("${ROOM_PASSWORD}") String roomPassword) {
        this.roomPassword = roomPassword;
    }

    public void registerSession(WebSocketSession session) {
        WebSocketSession concurrentSafeSession = new ConcurrentWebSocketSessionDecorator(
                session, SEND_TIME_LIMIT_MILLIS, SEND_BUFFER_LIMIT_BYTES);
        sessions.put(session.getId(), concurrentSafeSession);
    }

    public void handleMessage(WebSocketSession session, Map<String, Object> signal) throws IOException {
        Object rawType = signal.get("type");
        if (!(rawType instanceof String type)) {
            reject(session, "Tipo de mensagem ausente ou inválido.", CloseStatus.BAD_DATA);
            return;
        }

        if ("JOIN".equals(type)) {
            handleJoin(session, signal);
            return;
        }

        if (!joinedParticipants.contains(session.getId())) {
            reject(session, "Entre na sala antes de enviar sinalização.", CloseStatus.POLICY_VIOLATION);
            return;
        }

        if (!SIGNAL_TYPES.contains(type)) {
            reject(session, "Tipo de sinalização não suportado.", CloseStatus.BAD_DATA);
            return;
        }

        Object rawTargetId = signal.get("targetId");
        Object rawPayload = signal.get("payload");
        if (!(rawTargetId instanceof String targetId) || targetId.isBlank()
                || !(rawPayload instanceof String payload) || payload.isBlank()) {
            reject(session, "Destino ou conteúdo da sinalização inválido.", CloseStatus.BAD_DATA);
            return;
        }

        WebSocketSession targetSession = sessions.get(targetId);
        if (targetSession == null || !joinedParticipants.contains(targetId)) {
            return;
        }

        Map<String, Object> forwardedSignal = new HashMap<>();
        forwardedSignal.put("type", type);
        forwardedSignal.put("senderId", session.getId());
        forwardedSignal.put("payload", payload);
        try {
            send(targetSession, forwardedSignal);
        } catch (IOException | SessionLimitExceededException exception) {
            logger.warn("Could not forward signaling message to participant {}", targetId, exception);
            closeUnresponsiveSession(targetSession);
        }
    }

    public void reject(WebSocketSession session, String reason, CloseStatus status) throws IOException {
        try {
            send(sessions.getOrDefault(session.getId(), session),
                    Map.of("type", "ERROR", "payload", reason));
        } finally {
            session.close(status);
        }
    }

    public void removeSession(WebSocketSession session) {
        sessions.remove(session.getId());
        if (!joinedParticipants.remove(session.getId())) {
            return;
        }

        Map<String, Object> peerLeft = new HashMap<>();
        peerLeft.put("type", "PEER_LEFT");
        peerLeft.put("senderId", session.getId());
        broadcastToJoined(session.getId(), peerLeft);
    }

    private void handleJoin(WebSocketSession session, Map<String, Object> signal) throws IOException {
        Object rawPassword = signal.get("roomPassword");
        if (!(rawPassword instanceof String providedPassword) || !roomPassword.equals(providedPassword)) {
            reject(session, "Senha incorreta!", CloseStatus.POLICY_VIOLATION);
            return;
        }

        if (!joinedParticipants.add(session.getId())) {
            return;
        }

        var existingPeers = joinedParticipants.stream()
                .filter(id -> !id.equals(session.getId()))
                .toList();

        Map<String, Object> joined = new HashMap<>();
        joined.put("type", "ROOM_JOINED");
        joined.put("senderId", session.getId());
        joined.put("peers", existingPeers);
        send(sessions.get(session.getId()), joined);

        Map<String, Object> peerJoined = new HashMap<>();
        peerJoined.put("type", "PEER_JOINED");
        peerJoined.put("senderId", session.getId());
        broadcastToJoined(session.getId(), peerJoined);
    }

    private void send(WebSocketSession session, Object message) throws IOException {
        if (session != null && session.isOpen()) {
            session.sendMessage(new TextMessage(objectMapper.writeValueAsString(message)));
        }
    }

    private void broadcastToJoined(String excludedSessionId, Object message) {
        for (String participantId : joinedParticipants) {
            if (participantId.equals(excludedSessionId)) {
                continue;
            }
            WebSocketSession participantSession = sessions.get(participantId);
            try {
                send(participantSession, message);
            } catch (IOException | SessionLimitExceededException exception) {
                logger.warn("Could not send signaling message to participant {}", participantId, exception);
                closeUnresponsiveSession(participantSession);
            }
        }
    }

    private void closeUnresponsiveSession(WebSocketSession session) {
        if (session == null || !session.isOpen()) {
            return;
        }
        try {
            session.close(CloseStatus.SESSION_NOT_RELIABLE);
        } catch (IOException exception) {
            logger.debug("Could not close unresponsive WebSocket session {}", session.getId(), exception);
        }
    }
}
