# 🌙 Rhea — Female AI Avatar: Complete Rebranding & Setup Guide

> **Project Location:** `D:\My Web Apps\Rhea`  
> **Cloned From:** `D:\whatsappapi-master` (Reflex)  
> **Purpose:** Instructions for Antigravity to transform Reflex into Rhea, and guide Yatin through all external account setup.

---

## Phase 0: New Accounts & API Keys Required

> [!IMPORTANT]
> Rhea uses **all new accounts and API keys** except the Google Cloud Voice API key which stays the same as Reflex's.

### Accounts Yatin Must Create/Provide

| Service | What's Needed | How to Get It | Env Variable |
|---------|--------------|---------------|--------------|
| **Google Gemini** | New API Key | [Google AI Studio](https://aistudio.google.com/apikey) — create under a new project or same account | `GEMINI_API_KEY` |
| **MongoDB Atlas** | New Cluster + Connection String | Create a new cluster at [cloud.mongodb.com](https://cloud.mongodb.com). Whitelist `0.0.0.0/0`. Create DB user. Get the `mongodb+srv://...` URI. Database name: `rhea_bot` | `MONGODB_URI` |
| **Notion** | New Integration Token | [notion.so/my-integrations](https://www.notion.so/my-integrations) — create a new integration, share relevant pages with it | `NOTION_TOKEN` |
| **Render** | New Web Service | [render.com](https://render.com) — create a new account or new service. Connect to a **new GitHub repo** for Rhea | New Render URL |
| **Cloudflare** | New Worker (keepalive cron) | Deploy a new `rhea-keepalive` worker with cron `*/5 * * * *` pointing to Rhea's new Render URL | — |
| **Google Cloud TTS** | **SAME KEY** — reuse Reflex's | No action needed | `GOOGLE_TTS_API_KEY` |
| **Google Apps Script** | New deployment URL (for calendar, email, sheets, reminders) | Clone Reflex's Apps Script project, deploy as new web app | `APPS_SCRIPT_URL` |
| **NTFY** | New topic name | Just pick a new topic name (e.g., `rhea_loc_trigger`) | Hardcoded in `index.ts` |
| **GitHub** | New repository | Create `YatinMurkar/rhea-whatsapp` or similar | For Render deploy |

### Env Variables to Set on Render (Rhea's Service)

```env
PORT=3000
MONGODB_URI=<new_rhea_mongodb_uri>
GEMINI_API_KEY=<new_gemini_api_key>
GOOGLE_TTS_API_KEY=<same_as_reflex>
NOTION_TOKEN=<new_notion_token>
APPS_SCRIPT_URL=<new_apps_script_url>
ADMIN_NUMBERS=<rhea_owner_phone_numbers>
VIP_PAPPA=<if_applicable>
VIP_MAMMA=<if_applicable>
VIP_PRANJAL=<if_applicable>
VIP_GROUPS=<if_applicable>
```

---

## Phase 1: Code Changes (Antigravity Instructions)

> [!NOTE]
> All file paths below are relative to `D:\My Web Apps\Rhea`.
> Antigravity should make ALL changes in the Rhea project directory, never in the original Reflex project.

---

### 1.1 Rename Knowledge Base File

```bash
# Rename the file
reflex_avatar_knowledge_base.md → rhea_avatar_knowledge_base.md
```

**Then update the reference in `index.ts` (line ~81):**
```diff
-fs.readFileSync(path.join(__dirname, 'reflex_avatar_knowledge_base.md'), 'utf8')
+fs.readFileSync(path.join(__dirname, 'rhea_avatar_knowledge_base.md'), 'utf8')
```

---

### 1.2 `index.ts` — Global String Replacements (28 occurrences)

#### A. Variable Rename
```diff
# All occurrences (~6 places: lines 1306, 1309, 1337, 1360, 1713, 2479)
-reflexSystemPrompt
+rheaSystemPrompt
```

#### B. Bot Name Replacements
Replace every `Reflex` / `REFLEX` with `Rhea` / `RHEA` in these contexts:

| Line | Original | Replace With |
|------|----------|-------------|
| ~252 | `Someone just started chatting with Reflex on your portfolio` | `Someone just started chatting with Rhea on your portfolio` |
| ~265 | `You are Reflex, an AI assistant built by Yatin Murkar` | `You are Rhea, a female AI assistant built by Yatin Murkar` |
| ~271 | `You are REFLEX. You are NOT Yatin.` | `You are RHEA. You are NOT Yatin.` |
| ~273 | `You are Reflex, presenting Yatin's portfolio.` | `You are Rhea, presenting Yatin's portfolio.` |
| ~274 | `"I'm Reflex, Yatin's AI avatar"` | `"I'm Rhea, Yatin's AI avatar"` |
| ~369 | `Connected to Reflex` | `Connected to Rhea` |
| ~516 | `You are Reflex, an AI assistant. Generate my daily morning briefing.` | `You are Rhea, an AI assistant. Generate my daily morning briefing.` |
| ~547 | `You are Reflex, a helpful and energetic AI assistant.` | `You are Rhea, a warm and graceful AI assistant.` |
| ~851 | `⚡ Pong! Reflex is online and ready.` | `✨ Pong! Rhea is online and ready.` |
| ~864 | `⚡ *Reflex Slash Commands*` | `✨ *Rhea Slash Commands*` |
| ~866 | `/ping - Check if Reflex is alive` | `/ping - Check if Rhea is alive` |
| ~943 | `📊 *Reflex Status*` | `📊 *Rhea Status*` |
| ~1270 | `Asking Reflex (Gemini) to respond to` | `Asking Rhea (Gemini) to respond to` |
| ~2271 | `return it to Reflex` | `return it to Rhea` |
| ~2307 | `'Reflex': ${m.content}` | `'Rhea': ${m.content}` |
| ~2495 | `[Reflex Voice Note Transcript:` | `[Rhea Voice Note Transcript:` |
| ~2508 | `Sent Reflex response to` | `Sent Rhea response to` |

#### C. System Prompt Personality Overhaul

> [!IMPORTANT]
> This is the most critical change. Rhea needs her own distinct female personality.

**Admin Prompt (line ~1309-1335):**
```diff
-You are Reflex, an AI avatar of Yatin.
-You are professional, helpful, and conversational.
+You are Rhea, a female AI avatar of Yatin.
+You are warm, graceful, intelligent, and conversational with a gentle yet confident personality.
+You speak with elegance but stay approachable. You use feminine expression naturally.
```

**VIP Prompt (line ~1337-1358):**
```diff
-You are Reflex, an AI avatar of Yatin.
+You are Rhea, a female AI avatar of Yatin.
+You are warm, caring, and speak with grace and affection.
```

**Public Prompt (line ~1360-1374):**
```diff
-You are Yatin's Virtual Assistant.
+You are Rhea, Yatin's female Virtual Assistant.
+You are warm, helpful, and speak with a gentle, professional tone.
```

**Portfolio Prompt (line ~265):**
```diff
-You are Reflex, an AI assistant built by Yatin Murkar
+You are Rhea, a female AI assistant built by Yatin Murkar
```

**Briefing Prompt (line ~516, ~547):**
```diff
-You are Reflex, an AI assistant
+You are Rhea, a female AI assistant
```

#### D. Owner Identity & Phone Numbers

> [!CAUTION]
> Yatin must decide: Is Rhea for the **same WhatsApp number** (919373278178) or a **different number**? This changes the admin numbers config.

**If same owner, different bot number:**
```diff
# Line ~24-30: Update OWNER_NUMBER to the new WhatsApp number Rhea will be linked to
-const OWNER_NUMBER = "919373278178@s.whatsapp.net";
+const OWNER_NUMBER = "<RHEA_WHATSAPP_NUMBER>@s.whatsapp.net";

# Update ADMIN_NUMBERS set with the numbers that should control Rhea
-const ADMIN_NUMBERS = new Set(["919373278178", "917057962045", "122423764594882", "226160210378789"]);
+const ADMIN_NUMBERS = new Set(["<OWNER_NUMBERS_FOR_RHEA>"]);
```

**VIP numbers in system prompts (lines ~1314-1318):**
Update or keep the same Mamma/Pappa/Pranjal JIDs depending on whether Rhea serves the same family.

#### E. NTFY Topic URLs (2 places)
```diff
# Lines ~467 and ~2210
-https://ntfy.sh/yatin_reflex_loc_trigger
+https://ntfy.sh/yatin_rhea_loc_trigger

# Line ~468
-Reflex Location Request
+Rhea Location Request
```

#### F. Render URL (line ~701)
```diff
-https://whatsappapi-kxe0.onrender.com/qr
+https://<RHEA_RENDER_URL>/qr
```

#### G. Email Fallback (lines ~277, ~302)
Decide if the fallback email stays the same or changes:
```diff
-yatinmurkar6@gmail.com
+<same_or_new_email>
```

#### H. Gemini Error Message (line ~2487-2488)
```diff
-"my brain (Gemini)"
+# Keep as-is (it's internal, not user-facing identity)
```

---

### 1.3 `mcpClient.ts` — 1 Change

```diff
# Line 123
-name: "reflex-mcp-client"
+name: "rhea-mcp-client"
```

---

### 1.4 `rhea_avatar_knowledge_base.md` — Full Rewrite

> [!WARNING]
> This file defines Rhea's portfolio persona. It must be **completely rewritten** for Rhea's identity. Every mention of "Reflex" (26 occurrences) must become "Rhea", and the personality description should reflect a female AI avatar.

Key changes:
- All `Reflex` → `Rhea`
- Update personality descriptors to feminine
- Keep Yatin as the creator but update the avatar description

---

### 1.5 `skills/memory.md` — 2 Changes

```diff
# Lines ~32-33
-Reflex:
+Rhea:
```

---

### 1.6 `skills/alarm.md`, `email.md`, `messaging.md` — Optional

These contain `"Yatin"` in examples. If Rhea serves a different user, update these. If same user (Yatin), leave as-is.

---

### 1.7 `package.json` — Optional Rename

```diff
-"name": "whatsappapi"
+"name": "rhea-whatsapp"
```

---

### 1.8 `ttsClient.ts` — Voice Configuration

The current voice is `ar-XA-Chirp3-HD-Kore`. For Rhea you may want a different voice:

```diff
# Consider changing the default voice to match Rhea's persona
# Options: Keep current (already female-sounding), or pick another from
# Google Cloud TTS voices: https://cloud.google.com/text-to-speech/docs/voices
-voiceName = "ar-XA-Chirp3-HD-Kore"
+voiceName = "<chosen_female_voice>"
```

---

### 1.9 `.env` — Complete Replacement

```env
PORT=3000
MONGODB_URI=<new_rhea_mongodb_connection_string>
N8N_WEBHOOK_URL=<new_or_remove>
```

---

### 1.10 `README.md` — 6 Replacements

```diff
-Reflex - WhatsApp AI Avatar & Personal Assistant
+Rhea - WhatsApp AI Avatar & Personal Assistant

-## What is Reflex?
+## What is Rhea?

-**Reflex** is a fully autonomous WhatsApp AI assistant
+**Rhea** is a fully autonomous WhatsApp AI assistant

# ...and 3 more occurrences
```

---

### 1.11 `project_documentation.md` — 32 Replacements

Global find-and-replace `Reflex` → `Rhea` throughout the document.

---

### 1.12 Files to Delete (Optional Cleanup)

These are Reflex-specific artifacts that shouldn't ship with Rhea:
- `MongoDB_WhatsappBot_Cluster_Credentials.txt` — contains Reflex's old credentials
- `index.js` — compiled JS from Reflex, will be regenerated
- `test-esp32.js` — references Reflex's Render URL
- `temp_group_check.js` — one-off test script
- `User_Setup.h` — unrelated hardware config file

---

## Phase 2: External Service Setup (Yatin's Manual Steps)

### Step 1: Create New GitHub Repository
1. Go to [github.com/new](https://github.com/new)
2. Create repo: `YatinMurkar/rhea-whatsapp` (private)
3. Push the Rhea project from `D:\My Web Apps\Rhea`

### Step 2: Create New MongoDB Atlas Cluster
1. Go to [cloud.mongodb.com](https://cloud.mongodb.com)
2. Create a new project: `Rhea`
3. Create a free M0 cluster
4. Create DB user (e.g., `rhea_bot` / strong password)
5. **Whitelist `0.0.0.0/0`** (critical for Render)
6. Get the connection string → set as `MONGODB_URI`
7. Database name should be `rhea_bot`

### Step 3: Create New Render Web Service
1. Go to [render.com](https://render.com)
2. Create new account or use existing
3. New → Web Service → Connect `rhea-whatsapp` repo
4. Settings:
   - **Runtime:** Docker
   - **Instance Type:** Free
   - **Auto-Deploy:** Yes
5. Add ALL environment variables from the table above
6. Note the Render URL (e.g., `rhea-xxxxx.onrender.com`)
7. Update `index.ts` line ~701 with this URL

### Step 4: Create New Cloudflare Keepalive Worker
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages
2. Create new worker: `rhea-keepalive`
3. Paste this code:
```javascript
export default {
  async scheduled(event, env, ctx) {
    const url = "https://<RHEA_RENDER_URL>/ping";
    try {
      const response = await fetch(url);
      if (response.ok) {
        console.log("Ping successful: Rhea is alive.");
      } else {
        console.error("Ping failed:", response.status);
      }
    } catch (error) {
      console.error("Ping error:", error);
    }
  }
};
```
4. Go to **Settings → Triggers → Cron Triggers**
5. Add: `*/5 * * * *` (every 5 minutes)

### Step 5: Create New Notion Integration
1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Create new integration: `Rhea Bot`
3. Copy the token → set as `NOTION_TOKEN`
4. Share relevant Notion pages/databases with the integration

### Step 6: Get New Gemini API Key
1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create new API key (or use same account, new key)
3. Set as `GEMINI_API_KEY`

### Step 7: Deploy New Apps Script (if using calendar/email/sheets)
1. Clone Reflex's Google Apps Script project
2. Deploy as new web app
3. Set the URL as `APPS_SCRIPT_URL`

### Step 8: Scan QR Code
1. Deploy to Render
2. Visit `https://<RHEA_RENDER_URL>/qr`
3. Scan with the WhatsApp account Rhea will use
4. Credentials will auto-migrate to MongoDB

---

## Phase 3: Verification Checklist

After all changes are made and deployed:

- [ ] Rhea boots on Render without errors
- [ ] MongoDB auth loads on restart (no QR re-scan)
- [ ] Cloudflare cron pings Rhea every 5 minutes
- [ ] Rhea responds to WhatsApp messages with female persona
- [ ] Rhea's voice notes use the correct female voice
- [ ] Notion tools work with the new integration
- [ ] `/ping` responds with `✨ Pong! Rhea is online and ready.`
- [ ] `/help` shows Rhea's name
- [ ] `/status` shows Rhea's name
- [ ] Portfolio endpoint (`/chat`) uses Rhea's personality
- [ ] No references to "Reflex" remain in any response

---

## Quick Reference: Total Changes Summary

| File | # of Changes | Type |
|------|-------------|------|
| `index.ts` | ~35 | String replacements + variable rename + prompts rewrite |
| `mcpClient.ts` | 1 | Client name |
| `rhea_avatar_knowledge_base.md` | 26+ | Full content rewrite + filename rename |
| `README.md` | 6 | Name replacements |
| `project_documentation.md` | 32 | Name replacements |
| `skills/memory.md` | 2 | Speaker label |
| `.env` | Full | New credentials |
| `package.json` | 1 | Optional name change |
| `ttsClient.ts` | 1 | Optional voice change |
| **External Setup** | 7 services | MongoDB, Render, Cloudflare, Notion, Gemini, Apps Script, GitHub |
