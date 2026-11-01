# Publicação na Render

O projeto está separado em `frontend/` (site estático) e `backend/` (Spring Boot com WebSocket). O arquivo `render.yaml` descreve os dois serviços para publicação pelo Blueprint da Render.

## Publicar

1. Envie o repositório ao GitHub e, na Render, crie um Blueprint apontando para ele.
2. O Blueprint cria dois serviços:
   - **Backend:** serviço Docker usando `backend/Dockerfile`.
   - **Frontend:** site estático com raiz `frontend/`, comando de build `node build.mjs` e diretório publicado `dist`.
3. Ao configurar as variáveis solicitadas:
   - `ROOM_PASSWORD`: defina uma senha forte para a sala.
   - `FRONTEND_ORIGIN`: informe a origem HTTPS exata do site estático, por exemplo `https://screen-share-frontend.onrender.com`.
   - `WEBSOCKET_URL`: informe o endereço WSS do backend com o caminho `/signal`, por exemplo `wss://screen-share-backend.onrender.com/signal`.
   - `ICE_SERVERS_JSON` (opcional): informe um array JSON com servidores STUN/TURN. Sem essa variável, o frontend usa o STUN público já configurado.
4. Se a Render atribuir nomes/domínios diferentes, atualize `FRONTEND_ORIGIN` e `WEBSOCKET_URL` com os endereços reais. Depois de alterar `WEBSOCKET_URL` ou `ICE_SERVERS_JSON`, faça um novo deploy do frontend.
5. Acesse o endereço HTTPS do frontend. O formulário preencherá o endereço do backend automaticamente; a senha da sala continua sendo informada pelo usuário.

O backend lê a porta fornecida pela plataforma (`PORT`) e só aceita a origem configurada em `FRONTEND_ORIGIN`. A senha não deve ser colocada no código nem no frontend.

### Publicar o frontend em outro serviço estático

Se não usar o Blueprint, crie um serviço de site estático apontando para o repositório e configure:

- **Root directory:** `frontend`
- **Build command:** `node build.mjs`
- **Publish directory:** `dist`
- **`WEBSOCKET_URL`:** URL pública `wss://.../signal` do backend
- **`ICE_SERVERS_JSON`:** opcional; configure se for usar TURN

Depois de publicar, copie a origem HTTPS do frontend (sem caminho, por exemplo `https://meu-site.example.com`) para `FRONTEND_ORIGIN` no backend e faça novo deploy dele. O frontend e o backend são serviços separados; publicar um não publica o outro.

### Servidor TURN

STUN sozinho não conecta participantes em todas as redes. Para habilitar TURN, configure `ICE_SERVERS_JSON` no serviço estático, por exemplo:

```json
[
  { "urls": "stun:stun.example.com:3478" },
  {
    "urls": ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp"],
    "username": "usuario-fornecido-pelo-servico",
    "credential": "credencial-fornecida-pelo-servico"
  }
]
```

Substitua os endereços e credenciais pelos fornecidos pelo serviço TURN escolhido e faça novo deploy do frontend. Essa configuração é incluída no JavaScript público do site; não use credenciais permanentes. Prefira credenciais temporárias/de curta duração fornecidas por um serviço TURN. O tráfego de vídeo retransmitido por TURN consome a cota de tráfego desse serviço.

## Desenvolvimento local

Com `ROOM_PASSWORD` definido no `.env` da raiz, inicie o backend na raiz do repositório:

```powershell
mvn -f backend\pom.xml spring-boot:run
```

Em outro terminal, na raiz do repositório, sirva o frontend por HTTP:

```powershell
py -m http.server 5500 --directory frontend
```

Abra `http://localhost:5500`. O script de desenvolvimento usa `ws://localhost:8080/signal` automaticamente em `localhost`; não abra `index.html` diretamente como arquivo. O Python é necessário apenas para esse servidor local. Para publicar, o build do frontend é feito por `node build.mjs` e gera o site em `frontend/dist`.

## Limites atuais

O estado dos participantes e das conexões está na memória do backend. Mantenha uma única instância do backend; várias instâncias exigiriam um mecanismo compartilhado de sinalização/estado. O STUN público já configurado não garante conectividade em todas as redes; alguns participantes podem precisar de um servidor TURN.
