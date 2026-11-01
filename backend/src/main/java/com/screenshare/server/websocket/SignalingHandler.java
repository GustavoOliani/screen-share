package com.screenshare.server.websocket;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class SignalingHandler extends TextWebSocketHandler {

    @Value("${ROOM_PASSWORD}")
    private String roomPassword;

    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    private final Map<String, String> participantNames = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.put(session.getId(), session);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        Map<String, Object> sig = objectMapper.readValue(message.getPayload(), Map.class);
        String type = (String) sig.get("type");

        if ("JOIN".equals(type)) {
            String providedPassword = (String) sig.get("roomPassword");
            if (!roomPassword.equals(providedPassword)) {
                Map<String, Object> error = new HashMap<>();
                error.put("type", "ERROR");
                error.put("payload", "Senha incorreta!");
                session.sendMessage(new TextMessage(objectMapper.writeValueAsString(error)));
                session.close(CloseStatus.BAD_DATA);
                return;
            }

            String displayName = sig.get("displayName") instanceof String name
                    ? name.trim()
                    : "";
            if (displayName.isEmpty()) {
                displayName = "Participante";
            }
            if (displayName.length() > 40) {
                displayName = displayName.substring(0, 40);
            }

            List<Map<String, String>> existingPeers = new ArrayList<>();
            for (Map.Entry<String, String> participant : participantNames.entrySet()) {
                if (!participant.getKey().equals(session.getId())) {
                    Map<String, String> peer = new HashMap<>();
                    peer.put("id", participant.getKey());
                    peer.put("displayName", participant.getValue());
                    existingPeers.add(peer);
                }
            }
            participantNames.put(session.getId(), displayName);

            Map<String, Object> joined = new HashMap<>();
            joined.put("type", "ROOM_JOINED");
            joined.put("senderId", session.getId());
            joined.put("displayName", displayName);
            joined.put("peers", existingPeers);
            session.sendMessage(new TextMessage(objectMapper.writeValueAsString(joined)));

            for (WebSocketSession s : sessions.values()) {
                if (!s.getId().equals(session.getId()) && participantNames.containsKey(s.getId())) {
                    Map<String, Object> peerJoined = new HashMap<>();
                    peerJoined.put("type", "PEER_JOINED");
                    peerJoined.put("senderId", session.getId());
                    peerJoined.put("displayName", displayName);
                    s.sendMessage(new TextMessage(objectMapper.writeValueAsString(peerJoined)));
                }
            }
            return;
        }

        String targetId = (String) sig.get("targetId");
        if (targetId != null && sessions.containsKey(targetId)) {
            sig.put("senderId", session.getId());
            WebSocketSession targetSession = sessions.get(targetId);
            targetSession.sendMessage(new TextMessage(objectMapper.writeValueAsString(sig)));
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        sessions.remove(session.getId());
        if (participantNames.remove(session.getId()) == null) {
            return;
        }
        Map<String, Object> peerLeft = new HashMap<>();
        peerLeft.put("type", "PEER_LEFT");
        peerLeft.put("senderId", session.getId());
        String msg = objectMapper.writeValueAsString(peerLeft);
        for (WebSocketSession s : sessions.values()) {
            s.sendMessage(new TextMessage(msg));
        }
    }
}
