# Deployment Guide

Deploy AgentOffice locally, with Docker, or to the cloud.

---

## Local Development

```bash
# Terminal 1: Server
npm run start --workspace=@agent-office/server

# Terminal 2: UI
npm run dev --workspace=@agent-office/ui
```

Server runs on `ws://localhost:3000`, UI on `http://localhost:5173`.

---

## Docker Compose (Recommended)

The project includes a `docker-compose.yml` that starts everything:

```bash
docker compose up --build
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| **server** | 3000 | Colyseus WebSocket + Express API |
| **ui** | 80 | Nginx serving the Vite build |
| **redis** | 6379 | Pub/sub for multi-instance scaling |

### LLM inside Docker

The image does not include the Claude or Codex CLIs, so agents use an OpenAI-compatible API.
Export `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL` before `docker compose up`.

### Persistent Data

The server mounts `./data` for SQLite persistence:

```yaml
volumes:
  - ./data:/app/data  # Agent memories, tasks, layouts
```

---

## Cloud Deployment

### Railway / Render / Fly.io

1. Push your repo to GitHub
2. Connect the repo to your cloud provider
3. Set environment variables:
   - `DATABASE_URL=sqlite:/data/office.db`
   - `LLM_PROVIDER=openai`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`
4. Deploy the server package
5. Deploy the UI package separately (static site)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `LLM_PROVIDER` | `mixed` | Default brain: `claude`, `chatgpt`, `openai` or `mixed` |
| `OPENAI_BASE_URL` | (none) | OpenAI-compatible endpoint, e.g. `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | (none) | Key for that endpoint (stays on the server) |
| `OPENAI_MODEL` | `gpt-4o-mini` | Default model for the `openai` provider |
| `HOST` | `127.0.0.1` | Bind address; the server has no authentication |
| `DATABASE_URL` | `./data/office-memory.db` | SQLite database path |
| `REDIS_URL` | (none) | Redis for multi-instance |

---

## Production Considerations

- **LLM cost and latency:** Each think cycle is one LLM call. With 10 agents, `THINK_COOLDOWN_MS=30000` and `MAX_CONCURRENT_THINKS=3`, expect up to ~0.3 req/s. Lower the concurrency or set `ACTIVE_AGENTS` to spend less.
- **Memory Growth:** SQLite database grows with agent memories. Use the `importance` threshold to control embedding generation.
- **WebSocket Connections:** Colyseus handles 100+ spectators per room. For more, use Redis pub/sub with multiple server instances.
