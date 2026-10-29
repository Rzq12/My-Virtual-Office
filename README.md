# 🏢 AgentOffice

**Self-growing AI teams in a pixel-art virtual office — powered by the LLM of your choice.**

Watch AI agents walk to desks, think, collaborate, hire interns, assign tasks to each other, execute code, search the web, and grow their team — all rendered in real-time pixel art with persistent memory across sessions.

> **Zero lock-in.** Use your Claude Code or Codex CLI login, or any OpenAI-compatible API — and pick the model per agent.



https://github.com/user-attachments/assets/da76e31d-ff34-4ce1-9092-5bf9e6ee2058



[https://youtu.be/GgrK8K9RlIA](https://youtu.be/GgrK8K9RlIA)

<img width="1697" height="1272" alt="Screenshot at Feb 25 00-15-59" src="https://github.com/user-attachments/assets/9ed16692-09d9-44e4-a258-f796f9479afb" />
<img width="1694" height="1272" alt="Screenshot at Feb 25 00-16-31" src="https://github.com/user-attachments/assets/f592359a-ba96-45fc-bb5e-07ec88583a10" />
<img width="1699" height="1278" alt="screencapture-localhost-5173-2026-02-25-00_05_15" src="https://github.com/user-attachments/assets/4a604b86-1aaf-4b0d-985b-51afe7d71586" />
<img width="1699" height="1278" alt="screencapture-localhost-5173-2026-02-25-00_04_54" src="https://github.com/user-attachments/assets/4f2811ff-a66e-47e3-9d0f-184123e75e01" />
<img width="1699" height="1278" alt="screencapture-localhost-5173-2026-02-25-00_04_44" src="https://github.com/user-attachments/assets/8773814e-9414-4c62-a098-8f5a205db187" />
<img width="1695" height="1270" alt="Screenshot at Feb 25 00-18-57" src="https://github.com/user-attachments/assets/1591cb0e-9aea-4728-8f01-9f7a2c8d5ac2" />
<img width="2018" height="1268" alt="Screenshot at Feb 25 00-34-36" src="https://github.com/user-attachments/assets/f719ad99-f4ba-4998-8c9b-68818061bc60" />

---

## ✨ What Can It Do?

| Feature | Description |
|---------|-------------|
| 🧠 **LLM-Powered Agents** | Each agent has its own brain (Claude, ChatGPT or any OpenAI-compatible model), chosen per agent in the UI |
| 💬 **Agent-to-Agent Conversations** | Agents talk to each other autonomously and respond to messages |
| 🎯 **Click-to-Follow Focus Mode** | Click any agent sprite to have the camera smoothly track them |
| 📋 **UI Task Assignment** | Assign tasks from the TaskBoard — or agents create tasks for each other |
| 🤝 **Dynamic Hiring** | Agents can hire new team members (interns, devs, designers) on their own |
| 🔧 **Tool Execution** | Sandboxed JS execution, web search, note-taking, file reading |
| 💾 **Persistent Memory** | SQLite-backed memories survive server restarts with importance-weighted recall |
| 🔍 **Semantic Memory Search** | Optional OpenAI-compatible embeddings + cosine similarity for memory retrieval |
| 🏗️ **Layout Editor** | Drag-and-drop furniture placement, saved to database |
| 📊 **System Activity Log** | Real-time feed of all agent events with deduplication |
| 💡 **Emote Bubbles** | Action-specific emoji (💻💬😌🔧🚶💡) above agent sprites |
| 🪑 **Furniture Interaction** | Agents walk TO desks to work, approach each other to talk |

---

## 🎬 How It Works

```
You open the browser → pixel-art office loads → a 10-person software team spawns at their desks
  → Each agent runs a think loop via its own LLM (Claude CLI, Codex CLI or an OpenAI-compatible API)
  → LLM returns: { thought, action, target, toolCall }
  → Server executes the action (move, talk, use_tool, hire_agent)
  → Colyseus syncs state to all connected browsers in real-time
  → Agents remember everything via SQLite (+ optional embeddings)
  → Teams grow as agents decide to hire new members 🚀
```

---

## 🏗️ Architecture

```
agent-office/
├── packages/
│   ├── core/          # Agent state machine, Memory, Tasks, Office grid
│   ├── adapters/      # Claude/Codex CLI adapters, OpenAICompatibleAdapter, PromptBuilder
│   ├── server/        # Colyseus rooms, ToolExecutor, MemoryStore (SQLite)
│   ├── ui/            # Phaser.js game + React overlay (Chat, TaskBoard, SystemLog)
│   └── cli/           # Scaffold & management commands
├── examples/
│   └── openai-compatible-startup/  # Demo office with 2 agents
├── docs/              # Documentation (Docusaurus)
└── docker-compose.yml # One-command deployment
```

**Data Flow:**
```
LLM ←→ Adapter ←→ Agent.think() ←→ Colyseus State ←→ Phaser + React UI
                                  ↕                  ↕
                           MemoryStore (SQLite)   ToolExecutor
                           Embeddings (optional)  (code, search, tasks)
```

---

## 🚀 Quick Start

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | ≥ 22 | Runtime (the code sandbox uses Node's permission model) |
| **npm** | ≥ 9 | Package manager (workspaces) |
| **An LLM** | — | [Claude Code](https://claude.com/claude-code) login, [Codex CLI](https://github.com/openai/codex) login, or an OpenAI-compatible API key |

### Setup

```bash
# Clone & install
git clone https://github.com/AjStraworern/agent-office.git
cd agent-office
npm install

# Configure the LLM (see .env.example)
cp .env.example .env

# Build all packages
npm run build

# Terminal 1: Start server
npm run start --workspace=@agent-office/server

# Terminal 2: Start UI
npm run dev --workspace=@agent-office/ui
```

Open **http://localhost:5173** — watch the team come alive! 🎉

### The Team

| Agent | Role | Owns |
|-------|------|------|
| Alice | Software Engineer | Backend services, APIs, tested code |
| Bob | Product Manager | Scope, priorities, unblocking (can hire) |
| Citra | ML Engineer | Models, training, evaluation, serving |
| Dimas | DevOps Engineer | CI/CD, infra, containers, monitoring |
| Eka | Fullstack Developer | End-to-end React + Node features |
| Farhan | Tech Architect | Architecture and design reviews (can hire) |
| Gita | QA Engineer | Test plans, automation, release quality |
| Hana | UI/UX Designer | Flows, wireframes, accessibility |
| Irfan | Data Engineer | Pipelines, ETL, databases |
| Joko | Security Engineer | AppSec, auth, threat modeling |

Edit `packages/server/src/agents.ts` to change the roster, or set `ACTIVE_AGENTS=alice,bob,...` in `.env` to run a subset.
Talk to someone with `@Name` in the chat (`@all` for everyone; messages without a mention go to the PM).
Tasks are auto-assigned by role keywords, queue per agent, and are finished with the `complete_task` tool —
results land in `packages/server/workspace/notes/<agent>.md`. Every agent thought is one LLM call, so
`MAX_CONCURRENT_THINKS` and `THINK_COOLDOWN_MS` control how fast the team spends your quota.

---

## 🐳 Docker Deployment

```bash
docker compose up --build
```

This starts the **server** (port 3000), **UI** (port 80) and **Redis** (for scaling).
Inside Docker the agents use an OpenAI-compatible API, so export `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL` first.

---

## 🔧 Configuration

### Choose the LLM for each agent

Open the **🧠 Agent Models** panel in the left sidebar. Every agent has a provider and a model; change one agent
or use *Set every agent to* for the whole team. Choices are saved in SQLite and survive restarts.

| Provider | Setup |
|----------|-------|
| **Claude** | Log in once with `claude`; models `haiku`, `sonnet`, `opus` |
| **ChatGPT** | `npm i -g @openai/codex` and `codex login` |
| **OpenAI-compatible** | Set `OPENAI_BASE_URL`, `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) in `.env` — works with OpenAI, OpenRouter, Groq, Together, LM Studio, vLLM… The model list is read from the endpoint's `/models`. |

`LLM_PROVIDER` in `.env` (`claude`, `chatgpt`, `openai` or `mixed`) is only the default for agents you have not configured.
API keys never leave the server; the UI only sends provider and model names.

### Add Agents Manually

```typescript
await setupCoreAgent('charlie', 'Charlie', 'Designer', 15, 15);
```

Or let existing agents hire them dynamically via LLM! 🤝

---

## 🍴 Fork It & Build Your Own

AgentOffice is designed to be forked and customized. Here's how:

### Step 1: Fork & Clone

```bash
# Fork on GitHub, then:
git clone https://github.com/YOUR_USERNAME/agent-office.git
cd agent-office && npm install
```

### Step 2: Customize Agents

Edit `packages/server/src/rooms/OfficeRoom.ts` to change agent names, roles, personalities, and system prompts. The personality traits (openness, conscientiousness, extraversion, agreeableness, neuroticism) directly influence agent behavior.

### Step 3: Add Custom Tools

Create new tools in `packages/server/src/tools/ToolExecutor.ts`:

```typescript
case 'my_custom_tool':
    return this.myCustomTool(params);
```

Then add the capability to the agent config.

### Step 4: Change the Office Layout

Modify `furnitureTargets` in `OfficeRoom.ts` or use the in-browser Layout Editor to place and save furniture.

---

## 💡 Ideas: What Can You Build With This?

| Use Case | Description |
|----------|-------------|
| 🎓 **AI Classroom** | Teacher agent assigns lessons, student agents learn and ask questions |
| 🏥 **Virtual Hospital** | Doctor, nurse, and patient agents simulate a medical workflow |
| 🏭 **Factory Simulation** | Agents manage assembly lines, quality control, and logistics |
| 🎮 **Game NPC Engine** | Use AgentOffice as the brain for NPCs in your game |
| 📊 **Business Simulation** | CEO, CTO, and team agents run a startup — watch strategy emerge |
| 🧪 **Research Lab** | Agents read papers, discuss findings, and write collaborative reports |
| 🤖 **AI Interview Simulator** | Interviewer and candidate agents practice technical interviews |
| 🎭 **Social Experiment** | Study emergent behavior in AI agent groups with different personalities |
| 📚 **Study Group** | Agents quiz each other, explain concepts, and track learning progress |
| 🏗️ **DevOps Team** | Agents monitor services, create incident tickets, and coordinate fixes |

---

## 📦 Package Overview

| Package | Description |
|---------|-------------|
| `@agent-office/core` | Agent lifecycle (Perceive → Think → Act), Office grid, Task system, Memory with importance scoring |
| `@agent-office/adapters` | InferenceAdapter interface, Claude/Codex CLI adapters, OpenAICompatibleAdapter, PromptBuilder |
| `@agent-office/server` | Colyseus room, game loop, ToolExecutor (code/search/notes), MemoryStore (SQLite + embeddings) |
| `@agent-office/ui` | Phaser.js renderer, React overlay (Chat, TaskBoard, Inspector, SystemLog, LayoutEditor) |
| `@agent-office/cli` | `create-agent-office` scaffold, `add-agent` commands |

---

## 🧪 Testing

```bash
npm test                                    # All tests
npm test --workspace=@agent-office/core     # Core only
npm test --workspace=@agent-office/adapters # Adapters only
```

---

## 🗺️ Roadmap

- [x] Multi-agent conversations
- [x] UI task assignment
- [x] Persistent memory (SQLite)
- [x] Tool execution (code, search)
- [x] Custom layout editor
- [x] Agent Focus Mode
- [x] Dynamic agent hiring
- [x] Semantic memory search
- [x] System Activity Log
- [x] Emote Bubbles
- [ ] Voice mode (TTS/STT)
- [ ] GitHub PR integration
- [ ] Slack/Discord bridge
- [ ] Multiple office floors
- [ ] Plugin system for custom behaviors
- [ ] Mobile companion app

---

## 📘 Changelog

See release notes in [CHANGELOG.md](./CHANGELOG.md).

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

---

**Built with** Phaser.js · Colyseus · React · SQLite · TypeScript

**Star ⭐ this repo** if you think AI agents deserve their own office!

💙 Shout out to @pablodelucca for building and inspiring this project with [https://github.com/pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents)
