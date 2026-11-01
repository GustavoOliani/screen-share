package com.screenshare.server.websocket;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

@Component
public class SignalingHandler extends TextWebSocketHandler {

    private static final int MAX_MESSAGE_BYTES = 64 * 1024;

    private final SignalingService signalingService;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public SignalingHandler(SignalingService signalingService) {
        this.signalingService = signalingService;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        signalingService.registerSession(session);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        if (message.getPayload().getBytes(StandardCharsets.UTF_8).length > MAX_MESSAGE_BYTES) {
            signalingService.reject(session, "Mensagem excede o limite permitido.", CloseStatus.TOO_BIG_TO_PROCESS);
            return;
        }

        Map<String, Object> signal;
        try {
            signal = objectMapper.readValue(
                    message.getPayload(), new TypeReference<Map<String, Object>>() {});
        } catch (IOException exception) {
            signalingService.reject(session, "Mensagem JSON inválida.", CloseStatus.BAD_DATA);
            return;
        }
        if (signal == null) {
            signalingService.reject(session, "Mensagem JSON inválida.", CloseStatus.BAD_DATA);
            return;
        }

        signalingService.handleMessage(session, signal);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        signalingService.removeSession(session);
    }
}
