# 🦾 xclaw: Autonomous AI Agent Architecture

Xclaw is a high-performance, multi-channel autonomous agent designed for seamless interaction across Telegram, Twilio, and the Web. It functions as a digital "butler" or "scout," combining real-time voice intelligence with a suite of professional tools to manage your digital life.

## 🚀 Core Features

### 1. Multi-Channel Presence
- **Telegram Bot**: Full-featured interactive chat interface with support for markdown, media, and tool-triggering.
- **Twilio Live Voice**: Sub-second latency phone calls. Uses **OpenAI Realtime API** for listening and **Inworld TTS (Hades)** for high-fidelity voice output.
- **REST API Server**: An internal API layer that allows external applications (like the Xcue Chrome Extension) to push data or trigger agent actions.

### 2. Autonomous Watchers (Proactive Intelligence)
Xclaw doesn't just wait for you; it proactively monitors your world:
- **X-Butler**: Scans X (formerly Twitter) every 15 minutes for mentions, replies, and trends relevant to active users.
- **Reminder Engine**: A 60-second high-precision watcher that triggers notifications exactly when scheduled.
- **Post Scheduler**: Manages a queue of drafted content, posting to X or other platforms at optimal times.
- **Heartbeat System**: A configurable cron-based check-in system that allows Xclaw to reach out and "sync" with the user periodically.

## 🛠️ Tool Registry & Capabilities

Xclaw is equipped with a professional-grade "Utility Belt" of tools that it can execute autonomously to satisfy requests:

| Tool | Capability |
| :--- | :--- |
| **X (Twitter) Suite** | Post, Reply, Like, Retweet, Fetch Inbox (DMs), and Profile Management. |
| **Search Memory** | Full RAG (Retrieval-Augmented Generation) using **Pinecone** to remember past conversations and facts. |
| **Web Search** | Live internet access via **Tavily API** to browse current news and research topics. |
| **Calendar & Email** | Native integration to check availability, schedule meetings, and send professional emails. |
| **Reminders** | Persistence-backed system to set, delete, and list tasks. |
| **Telegram Media** | Handles file uploads, image processing, and media-rich responses. |
| **Thread Management** | Manages conversation state and history to maintain deep contextual awareness. |

## 🧠 Autonomous Logic

Xclaw operates as a "Loop-based" agent:
1. **Perception**: Receives a prompt from Telegram, Twilio voice audio, or a background watcher trigger.
2. **Planning**: Uses **Gemini 2.0 Flash** or **GPT-4o Realtime** to parse intent and determine which tools are required.
3. **Execution**: Autonomously calls the necessary tools (e.g., searches your memory, then browses the web, then drafts a post).
4. **Validation**: Reviews tool outputs to ensure accuracy before responding to the user.
5. **Persistence**: Automatically saves new learnings and "memories" back into the database for future retrieval.

---
*Xclaw is built for builders, providing a state-of-the-art framework for "Vibe Coding" and high-latency/low-latency hybrid AI interactions.*
