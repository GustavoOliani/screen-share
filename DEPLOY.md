# Publicação na Render

O projeto está separado em `frontend/` (site estático) e `backend/` (Spring Boot com WebSocket). O arquivo `render.yaml` descreve os dois serviços para publicação pelo Blueprint da Render.

## Publicar

1. Envie o repositório ao GitHub e, na Render, crie um Blueprint apontando para ele.
2. Ao configurar as variáveis solicitadas:
   - `ROOM_PASSWORD`: defina uma senha forte para a sala.
   - `FRONTEND_ORIGIN`: informe a origem HTTPS exata do site estático, por exemplo `https://screen-share-frontend.onrender.com`.
   - `WEBSOCKET_URL`: informe o endereço WSS do backend com o caminho `/signal`, por exemplo `wss://screen-share-backend.onrender.com/signal`.
3. Se a Render atribuir nomes/domínios diferentes, use os domínios reais dos serviços. Depois de alterar `WEBSOCKET_URL`, faça um novo deploy do frontend.
4. Acesse o endereço HTTPS do frontend. O formulário preencherá o endereço do backend automaticamente; a senha da sala continua sendo informada pelo usuário.

O backend lê a porta fornecida pela plataforma (`PORT`) e só aceita a origem configurada em `FRONTEND_ORIGIN`. A senha não deve ser colocada no código nem no frontend.

## Desenvolvimento local

Com `ROOM_PASSWORD` definido no `.env` da raiz, inicie o backend na raiz do repositório:

```powershell
mvn -f backend\pom.xml spring-boot:run
```

Para desenvolver a interface, sirva a pasta `frontend/` com um servidor HTTP local. Em `localhost`, o formulário usa `ws://localhost:8080/signal` por padrão.

## Limites atuais

O estado dos participantes e das conexões está na memória do backend. Mantenha uma única instância do backend; várias instâncias exigiriam um mecanismo compartilhado de sinalização/estado. O STUN público já configurado não garante conectividade em todas as redes; alguns participantes podem precisar de um servidor TURN.
