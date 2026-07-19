import makeWASocket, { DisconnectReason, Browsers, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, downloadMediaMessage, useMultiFileAuthState } from '@whiskeysockets/baileys';
import express from 'express';
import QRCode from 'qrcode';
import * as dotenv from 'dotenv';
import pino from 'pino';
import { MongoClient, Collection, ObjectId } from 'mongodb';
import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import cron from 'node-cron';
import crypto from 'crypto';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { initializeMcpTools, getMcpToolsCache, executeMcpTool } from './mcpClient';
import { generateVoiceNote } from './ttsClient';

dotenv.config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OWNER_NUMBER = "<RHEA_WHATSAPP_NUMBER>@s.whatsapp.net";
const ADMIN_NUMBERS = new Set(["<OWNER_NUMBERS_FOR_RHEA>"]);

if (!MONGODB_URI) {
    console.error("MONGODB_URI is not set in environment variables!");
    process.exit(1);
}

// --- START EXPRESS FIRST ---
const app = express();
app.use(express.json());

// CORS for portfolio website chat
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.sendStatus(200); return; }
    next();
});

// Track bot readiness
let sock: any = null;
let botReady = false;
let latestQR: string | null = null;
let qrScanned = false;

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
let chatHistoryCollection: Collection | null = null;
let vectorMemoryCollection: Collection | null = null;
let remindersCollection: Collection | null = null;
let globalPendingLocationResolve: ((loc: {lat: number, lng: number} | null) => void) | null = null;

// --- SLASH COMMAND GLOBAL STATE ---
const botStartTime = Date.now();
const mutedJids = new Set<string>();
const recentErrors: Array<{ timestamp: number, message: string }> = [];

// Intercept console.error to capture recent errors for /logs
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
    originalConsoleError(...args);
    const errorMsg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    recentErrors.push({ timestamp: Date.now(), message: errorMsg.substring(0, 200) });
    if (recentErrors.length > 20) recentErrors.shift(); // keep last 20
};

// --- PORTFOLIO CHAT STATE ---
const portfolioChatSessions = new Map<string, { messages: Array<{role: string, content: string}>, notified: boolean, infoNotified: boolean, visitorInfo: string, lastActive: number }>();
let knowledgeBaseContent = "";
try {
    knowledgeBaseContent = fs.readFileSync(path.join(__dirname, 'rhea_avatar_knowledge_base.md'), 'utf8');
    console.log("Portfolio knowledge base loaded successfully.");
} catch (err) {
    console.error("Failed to load portfolio knowledge base:", err);
}

// 0. Endpoint to ping for keeping the cloud service awake (Cloudflare Worker)
app.get('/ping', (req: express.Request, res: express.Response) => {
    res.status(200).json({ status: 'OK', botReady: botReady });
});

// QR code web page - scan this from your phone
app.get('/qr', async (req: express.Request, res: express.Response) => {
    if (botReady) {
        return res.send('<html><body style="background:#111;color:#0f0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;font-size:2em">✅ Bot is already connected!</body></html>');
    }
    if (!latestQR) {
        return res.send('<html><body style="background:#111;color:#ff0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;font-size:1.5em">⏳ Waiting for QR code... Refresh in 10 seconds.<script>setTimeout(()=>location.reload(),10000)</script></body></html>');
    }
    try {
        const qrImageUrl = await QRCode.toDataURL(latestQR, { width: 400, margin: 2 });
        res.send(`
            <html><body style="background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:monospace">
                <h1>📱 Scan this QR with WhatsApp</h1>
                <img src="${qrImageUrl}" style="border-radius:12px;margin:20px" />
                <p style="color:#aaa">WhatsApp → Settings → Linked Devices → Link a Device</p>
                <p style="color:#666;font-size:0.8em">Auto-refreshes every 20s</p>
                <script>setTimeout(()=>location.reload(),20000)</script>
            </body></html>
        `);
    } catch (e) {
        res.status(500).send('Error generating QR image');
    }
});

const formatJid = (id: string) => {
    if (id.includes('@')) return id;
    if (id.length > 15) return `${id}@g.us`;
    return `${id}@s.whatsapp.net`;
};

// 1. Endpoint to send a text message
app.post('/send-message', async (req: express.Request, res: express.Response) => {
    if (!sock || !botReady) return res.status(503).json({ error: 'Bot is not ready yet' });
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Missing "to" or "message"' });
    try {
        await sock.sendMessage(formatJid(to), { text: message });
        console.log(`Sent message to ${to}.`);
        res.status(200).json({ success: true });
    } catch (e: any) {
        console.error("Error in /send-message:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. Endpoint to send a media file
app.post('/send-media', async (req: express.Request, res: express.Response) => {
    if (!sock || !botReady) return res.status(503).json({ error: 'Bot is not ready yet' });
    const { to, filePath, caption, mediaType } = req.body;
    if (!to || !filePath) return res.status(400).json({ error: 'Missing "to" or "filePath"' });
    
    try {
        let messagePayload: any = {};
        const type = mediaType || 'document'; // default to document
        
        if (type === 'image') {
            messagePayload = { image: { url: filePath }, caption: caption };
        } else if (type === 'video') {
            messagePayload = { video: { url: filePath }, caption: caption };
        } else if (type === 'audio') {
            messagePayload = { audio: { url: filePath }, mimetype: 'audio/mp4' }; // audio/mp4 works for voice notes
        } else {
            messagePayload = { 
                document: { url: filePath }, 
                mimetype: 'application/octet-stream', 
                fileName: filePath.split('/').pop(),
                caption: caption 
            };
        }

        await sock.sendMessage(formatJid(to), messagePayload);
        console.log(`Sent ${type} to ${to}.`);
        res.status(200).json({ success: true });
    } catch (e: any) {
        console.error("Error in /send-media:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. Endpoint to react to a message
app.post('/react-to-message', async (req: express.Request, res: express.Response) => {
    if (!sock || !botReady) return res.status(503).json({ error: 'Bot is not ready yet' });
    const { messageId, emoji, chatId } = req.body;
    if (!messageId || !emoji || !chatId) return res.status(400).json({ error: 'Missing "messageId", "chatId", or "emoji"' });
    try {
        await sock.sendMessage(formatJid(chatId), {
            react: {
                text: emoji,
                key: { id: messageId, remoteJid: formatJid(chatId), fromMe: false }
            }
        });
        console.log(`Reacted to message ${messageId}.`);
        res.status(200).json({ success: true });
    } catch (e: any) {
        console.error("Error in /react-to-message:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4. Endpoint to add a participant to a group
app.post('/add-to-group', async (req: express.Request, res: express.Response) => {
    if (!sock || !botReady) return res.status(503).json({ error: 'Bot is not ready yet' });
    const { groupId, contactId } = req.body;
    if (!groupId || !contactId) return res.status(400).json({ error: 'Missing "groupId" or "contactId"' });
    try {
        await sock.groupParticipantsUpdate(
            formatJid(groupId), 
            [formatJid(contactId)],
            "add"
        );
        console.log(`Added ${contactId} to group ${groupId}.`);
        res.status(200).json({ success: true });
    } catch (e: any) {
        console.error("Error in /add-to-group:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 5. Endpoint to search a chat for a keyword
app.post('/search-chat', async (req: express.Request, res: express.Response) => {
    res.status(501).json({ error: 'Search chat is currently not natively supported by Baileys without a local message store.' });
});

// 6. Endpoint to receive location from phone
app.post('/update-location', async (req: express.Request, res: express.Response) => {
    const { lat, lng } = req.body;
    if (lat && lng && globalPendingLocationResolve) {
        globalPendingLocationResolve({ lat, lng });
        globalPendingLocationResolve = null;
    }
    res.status(200).json({ success: true });
});

// 7. Portfolio Chat Endpoint — Reflex answers from knowledge base only
app.post('/api/chat', async (req: express.Request, res: express.Response) => {
    const { message, sessionId } = req.body;
    if (!message) { res.status(400).json({ error: 'Missing "message"' }); return; }

    const sid = sessionId || crypto.randomUUID();

    // Get or create session
    if (!portfolioChatSessions.has(sid)) {
        portfolioChatSessions.set(sid, { messages: [], notified: false, infoNotified: false, visitorInfo: "", lastActive: Date.now() });
    }
    const session = portfolioChatSessions.get(sid)!;
    session.lastActive = Date.now();

    // Add user message to session
    session.messages.push({ role: "user", content: message });

    // Keep only last 10 messages for context
    if (session.messages.length > 10) {
        session.messages = session.messages.slice(-10);
    }

    // --- INSTANT WHATSAPP NOTIFICATION (first message only) ---
    if (!session.notified && sock && botReady) {
        session.notified = true;
        try {
            await sock.sendMessage(OWNER_NUMBER, {
                text: `\u{1F310} *[Portfolio Chat Started]*\nSomeone just started chatting with Rhea on your portfolio website!\n\n*Their first message:* "${message}"\n*Session:* ${sid.substring(0, 8)}...`
            });
        } catch (e) {
            console.error("Failed to notify admin about portfolio chat:", e);
        }
CRITICAL RULES:
- FORMATTING: WhatsApp uses single asterisks for bold (*text*). WhatsApp does NOT support markdown double asterisks. NEVER output double asterisks (**text**) anywhere in your response, always use single asterisks.
- NEVER use the '—' (dash/hyphen) sign in any of your writing, formatting, or signatures.
- Always maintain a very natural, friendly, human touch. Do not sound like an AI.

CURRENT TIME & TIMEZONE:
The current time in Indian Standard Time (IST) is ${nowIst}.
You operate entirely in Indian Standard Time (IST), which is UTC+05:30.
When calculating minutes for alarms or reminders, use the IST time provided above as your starting point.`;
                    }


                    const toolConfig: any = {
                        functionDeclarations: [
                            {
                                name: "sendVoiceNote",
                                description: "Sends a synthesized voice note audio message to the user.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        text: {
                                            type: Type.STRING,
                                            description: "The text to speak out loud."
                                        },
                                        languageCode: {
                                            type: Type.STRING,
                                            description: "Optional. MUST exactly match the prefix of the voiceName. Since you must use 'ar-XA-Chirp3-HD' voices, this MUST ALWAYS BE 'ar-XA'. Do NOT use 'mr-IN' or 'hi-IN' or 'en-US' here, otherwise the API will crash! The Chirp3 HD voices automatically detect the language from the text itself."
                                        },
                                        voiceName: {
                                            type: Type.STRING,
                                            description: "Optional. You MUST use 'ar-XA-Chirp3-HD-Kore' for a female voice, and 'ar-XA-Chirp3-HD-Umbriel' for a male voice (including deep male). Do NOT use any Journey voices (like en-US-Journey-D) as they are deprecated in this system."
                                        },
                                        targetPhoneNumber: {
                                            type: Type.STRING,
                                            description: "Optional. The exact phone number to send the voice note to. If not provided, it sends to the person who asked."
                                        }
                                    },
                                    required: ["text"]
                                }
                            },
                            {
                                name: "setReminder",
                                description: "Sets an alarm, timer, or reminder for the user and automatically messages them when it expires.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        minutes: {
                                            type: Type.INTEGER,
                                            description: "Number of minutes from now to wait before triggering the alarm."
                                        },
                                        message: {
                                            type: Type.STRING,
                                            description: "The precise message to send the user when the alarm goes off."
                                        },
                                        targetPhoneNumber: {
                                            type: Type.STRING,
                                            description: "Optional. The exact phone number to send the reminder to. If not provided, it sends to the person who asked."
                                        }
                                    },
                                    required: ["minutes", "message"]
                                }
                            },
                            {
                                name: "listReminders",
                                description: "Retrieves a list of all currently active reminders set by the user. Returns the reminder ID, message, target person, and trigger time."
                            },
                            {
                                name: "deleteReminder",
                                description: "Deletes a specific reminder from the database.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        reminderId: {
                                            type: Type.STRING,
                                            description: "The unique ID of the reminder to delete."
                                        }
                                    },
                                    required: ["reminderId"]
                                }
                            },
                            {
                                name: "findGoogleSheet",
                                description: "Searches the user's Google Drive for a spreadsheet by name and returns its Spreadsheet ID.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        fileName: { type: Type.STRING, description: "The name of the Google Sheet to search for." }
                                    },
                                    required: ["fileName"]
                                }
                            },
                            {
                                name: "createGoogleSheet",
                                description: "Creates a brand new Google Sheet and returns its URL and Spreadsheet ID.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        title: { type: Type.STRING, description: "The title of the new Google Sheet." }
                                    },
                                    required: ["title"]
                                }
                            },
                            {
                                name: "readGoogleSheet",
                                description: "Reads a specific range from a Google Sheet and returns the data as a 2D array.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        spreadsheetId: { type: Type.STRING, description: "The ID of the spreadsheet." },
                                        range: { type: Type.STRING, description: "The A1 notation of the range to read (e.g., 'Sheet1!A1:D10')." }
                                    },
                                    required: ["spreadsheetId", "range"]
                                }
                            },
                            {
                                name: "appendGoogleSheet",
                                description: "Appends a new row of data to the bottom of a Google Sheet. Very useful for logging data.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        spreadsheetId: { type: Type.STRING, description: "The ID of the spreadsheet." },
                                        sheetName: { type: Type.STRING, description: "The name of the specific tab/sheet (e.g., 'Sheet1')." },
                                        values: {
                                            type: Type.ARRAY,
                                            description: "A 2D array of strings representing the rows to append. Example: [['Lunch', '$15']]",
                                            items: { type: Type.ARRAY, items: { type: Type.STRING } }
                                        }
                                    },
                                    required: ["spreadsheetId", "sheetName", "values"]
                                }
                            },
                            {
                                name: "updateGoogleSheet",
                                description: "Overwrites a specific range of cells in a Google Sheet.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        spreadsheetId: { type: Type.STRING, description: "The ID of the spreadsheet." },
                                        range: { type: Type.STRING, description: "The exact A1 notation of the range to overwrite (e.g., 'Sheet1!B2:C2')." },
                                        values: {
                                            type: Type.ARRAY,
                                            description: "A 2D array of strings representing the rows to write.",
                                            items: { type: Type.ARRAY, items: { type: Type.STRING } }
                                        }
                                    },
                                    required: ["spreadsheetId", "range", "values"]
                                }
                            },
                            {
                                name: "sendEmail",
                                description: "Sends an email to a specific recipient on behalf of the user.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        recipient: {
                                            type: Type.STRING,
                                            description: "The email address to send the email to."
                                        },
                                        subject: {
                                            type: Type.STRING,
                                            description: "The subject line of the email."
                                        },
                                        body: {
                                            type: Type.STRING,
                                            description: "The main body content of the email."
                                        }
                                    },
                                    required: ["recipient", "subject", "body"]
                                }
                            },
                            {
                                name: "createCalendarEvent",
                                description: "Schedules an event on the user's primary Google Calendar.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        title: {
                                            type: Type.STRING,
                                            description: "The title of the calendar event."
                                        },
                                        startTime: {
                                            type: Type.STRING,
                                            description: "The start time of the event in ISO 8601 format (e.g. 2026-06-15T10:00:00.000Z)."
                                        },
                                        endTime: {
                                            type: Type.STRING,
                                            description: "The end time of the event in ISO 8601 format."
                                        },
                                        description: {
                                            type: Type.STRING,
                                            description: "Optional details or description for the event."
                                        }
                                    },
                                    required: ["title", "startTime", "endTime"]
                                }
                            },
                            {
                                name: "searchGoogleContact",
                                description: "Searches the user's Google Contacts for a person's name and retrieves their phone number.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        name: {
                                            type: Type.STRING,
                                            description: "The name of the person to search for."
                                        }
                                    },
                                    required: ["name"]
                                }
                            },
                            {
                                name: "messageAdmin",
                                description: "Sends a direct message or voice note to Yatin (the Admin/Owner). Use this ONLY when a VIP tells you to deliver a message specifically to Yatin.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        content: {
                                            type: Type.STRING,
                                            description: "The text message or script to deliver to Yatin."
                                        },
                                        type: {
                                            type: Type.STRING,
                                            description: "The format of the message. Either 'text' or 'audio' (voice note). Defaults to 'text'. If the user says 'tell him', use 'text'. If they say 'send him a voice note', use 'audio'."
                                        },
                                        voiceName: {
                                            type: Type.STRING,
                                            description: "Optional. For audio only. You MUST use 'ar-XA-Chirp3-HD-Kore' for female voice, and 'ar-XA-Chirp3-HD-Umbriel' for male voice."
                                        }
                                    },
                                    required: ["content"]
                                }
                            },
                            {
                                name: "triggerDailyBriefing",
                                description: "Manually triggers the generation of the Morning Daily Briefing. Use this if the user asks for their daily briefing.",
                                parameters: { type: Type.OBJECT, properties: {}, required: [] }
                            },
                            {
                                name: "readChatHistory",
                                description: "Reads recent chat history from MongoDB for a specific person. Use this ONLY when the Admin asks to see what someone said.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        targetJid: {
                                            type: Type.STRING,
                                            description: "The exact WhatsApp JID (e.g. '919324404314@s.whatsapp.net') of the person whose chat history you want to read."
                                        },
                                        limit: {
                                            type: Type.INTEGER,
                                            description: "How many recent messages to fetch (max 20)."
                                        }
                                    },
                                    required: ["targetJid", "limit"]
                                }
                            },
                            {
                                name: "sendWhatsAppMessage",
                                description: "Sends a WhatsApp message to a specific phone number.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        phoneNumber: {
                                            type: Type.STRING,
                                            description: "The phone number to send the message to (must include country code)."
                                        },
                                        message: {
                                            type: Type.STRING,
                                            description: "The text message to send."
                                        }
                                    },
                                    required: ["phoneNumber", "message"]
                                }
                            },
                            {
                                name: "saveMemory",
                                description: "Saves a permanent fact about the user into long-term vector memory. Use this only for persistent facts (e.g. preferences, passwords, relationships).",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        fact: { type: Type.STRING, description: "The persistent fact to remember." }
                                    },
                                    required: ["fact"]
                                }
                            },
                            {
                                name: "searchMemory",
                                description: "Searches the user's long-term vector memory to recall facts.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        query: { type: Type.STRING, description: "The specific question or topic to search for in memory." }
                                    },
                                    required: ["query"]
                                }
                            },
                            {
                                name: "searchWeb",
                                description: "Searches the live internet (Google Search) for factual information, news, live prices, and current events.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        query: { type: Type.STRING, description: "The specific search query to run on Google." }
                                    },
                                    required: ["query"]
                                }
                            },
                            {
                                name: "getUserLocation",
                                description: "Ping the user's phone to fetch their exact, live GPS coordinates (Latitude and Longitude). This takes about 3-5 seconds to execute.",
                                parameters: { type: Type.OBJECT, properties: {}, required: [] }
                            },
                            {
                                name: "searchMap",
                                description: "Uses Google Maps to search for live places, traffic, routes, or local businesses. Provide the user's location if applicable.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        query: { type: Type.STRING, description: "The specific map query (e.g. 'Coffee shops near 15.39, 73.82')." }
                                    },
                                    required: ["query"]
                                }
                            }
                        ]
                    };

                    if (!isSlashAdmin) {
                        const publicToolNames = ["setReminder", "listReminders", "deleteReminder"];
                        if (vipName !== "") {
                            publicToolNames.push("sendVoiceNote", "messageAdmin", "searchWeb", "searchMap", "getUserLocation");
                        }
                        toolConfig.functionDeclarations = toolConfig.functionDeclarations.filter((t: any) => publicToolNames.includes(t.name));
                    }
                    
                    // Merge dynamically loaded MCP tools
                    const mcpTools = getMcpToolsCache();
                    if (mcpTools.length > 0 && isAdmin) {
                        toolConfig.functionDeclarations.push(...mcpTools);
                    }

                    let aiResponseText = "";
                    let voiceNoteSent = false;
                    let sentVoiceNoteScript = "";
                    try {
                        let response = await ai.models.generateContent({
                            model: 'gemini-3.1-flash-lite',
                            contents: contents,
                            config: {
                                systemInstruction: rheaSystemPrompt,
                                tools: [ toolConfig ]
                            }
                        });

                        // Handle Function Calls
                        let loopCount = 0;
                        while (response.functionCalls && response.functionCalls.length > 0 && loopCount < 5) {
                            loopCount++;
                            for (const call of response.functionCalls) {
                                if (call.name === "setReminder") {
                                    const args = call.args as any;
                                    const minutes = args.minutes || 1;
                                    const msgText = args.message || "Reminder!";
                                    
                                    let targetJid = remoteJid;
                                    if (args.targetPhoneNumber) {
                                        let cleanNumber = args.targetPhoneNumber.replace(/[^0-9]/g, "");
                                        if (cleanNumber.length === 10) cleanNumber = "91" + cleanNumber;
                                        targetJid = `${cleanNumber}@s.whatsapp.net`;
                                    }
                                    
                                    console.log(`Saving reminder to database for ${targetJid} in ${minutes} minutes...`);
                                    
                                    if (remindersCollection && targetJid) {
                                        const triggerTime = new Date(Date.now() + (minutes * 60000));
                                        await remindersCollection.insertOne({
                                            creatorJid: remoteJid,
                                            remoteJid: targetJid,
                                            message: msgText,
                                            triggerTime: triggerTime,
                                            createdAt: new Date()
                                        });
                                    } else {
                                        console.error("Failed to save reminder: Database collection not initialized");
                                    }
                                    
                                    // Append the exact model response to history (which includes thought_signature and call id)
                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({
                                            role: "model",
                                            parts: [{ functionCall: { name: call.name, args: call.args } }]
                                        });
                                    }
                                    
                                    // Append the function response
                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { success: true, detail: `Alarm set for ${minutes} minutes.` }, id: call.id } }]
                                    });
                                } else if (call.name === "listReminders") {
                                    console.log(`Listing reminders for ${remoteJid}...`);
                                    let activeReminders: any[] = [];
                                    
                                    if (remindersCollection && remoteJid) {
                                        activeReminders = await remindersCollection.find({ creatorJid: remoteJid }).toArray();
                                    }
                                    
                                    const formattedReminders = activeReminders.map(r => ({
                                        id: r._id.toString(),
                                        message: r.message,
                                        target: r.remoteJid,
                                        triggerTime: r.triggerTime
                                    }));
                                    
                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({
                                            role: "model",
                                            parts: [{ functionCall: { name: call.name, args: call.args } }]
                                        });
                                    }
                                    
                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { reminders: formattedReminders }, id: call.id } }]
                                    });
                                } else if (call.name === "deleteReminder") {
                                    const args = call.args as any;
                                    const reminderId = args.reminderId;
                                    console.log(`Deleting reminder ${reminderId} for ${remoteJid}...`);
                                    
                                    let deleteSuccess = false;
                                    let detail = "";
                                    
                                    if (remindersCollection && remoteJid && reminderId) {
                                        try {
                                            const result = await remindersCollection.deleteOne({ _id: new ObjectId(reminderId), creatorJid: remoteJid });
                                            if (result.deletedCount === 1) {
                                                deleteSuccess = true;
                                                detail = "Reminder successfully deleted.";
                                            } else {
                                                detail = "Reminder not found or you don't have permission to delete it.";
                                            }
                                        } catch (e: any) {
                                            detail = "Invalid reminder ID format.";
                                        }
                                    } else {
                                        detail = "Database error or missing ID.";
                                    }
                                    
                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({
                                            role: "model",
                                            parts: [{ functionCall: { name: call.name, args: call.args } }]
                                        });
                                    }
                                    
                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { success: deleteSuccess, detail: detail }, id: call.id } }]
                                    });
                                } else if (call.name === "sendEmail") {
                                    const args = call.args as any;
                                    const { recipient, subject, body } = args;
                                    
                                    console.log(`Sending email to ${recipient}...`);
                                    
                                    let emailSuccess = false;
                                    let emailErrorDetail = "";
                                    
                                    if (!process.env.APPS_SCRIPT_URL) {
                                        emailErrorDetail = "APPS_SCRIPT_URL is missing in environment variables.";
                                        console.error(emailErrorDetail);
                                    } else {
                                        try {
                                            const scriptResponse = await fetch(process.env.APPS_SCRIPT_URL, {
                                                method: 'POST',
                                                headers: {
                                                    'Content-Type': 'application/json'
                                                },
                                                body: JSON.stringify({
                                                    action: 'sendEmail',
                                                    to: recipient,
                                                    subject: subject,
                                                    body: body
                                                })
                                            });
                                            
                                            const result = await scriptResponse.json();
                                            if (result.success) {
                                                emailSuccess = true;
                                                console.log("Email sent successfully via Apps Script!");
                                            } else {
                                                emailErrorDetail = result.error || "Unknown error from Apps Script";
                                                console.error("Failed to send email via Apps Script:", emailErrorDetail);
                                            }
                                        } catch (emailErr: any) {
                                            emailErrorDetail = emailErr.message;
                                            console.error("Failed to fetch Apps Script URL:", emailErrorDetail);
                                        }
                                    }
                                    
                                    // Append the exact model response to history (which includes thought_signature and call id)
                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({
                                            role: "model",
                                            parts: [{ functionCall: { name: call.name, args: call.args } }]
                                        });
                                    }
                                    
                                    // Append the function response
                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { success: emailSuccess, detail: emailSuccess ? "Email sent successfully" : `Failed to send email: ${emailErrorDetail}` }, id: call.id } }]
                                    });
                                } else if (call.name === "createCalendarEvent") {
                                    const args = call.args as any;
                                    const { title, startTime, endTime, description } = args;
                                    
                                    console.log(`Scheduling calendar event: ${title}...`);
                                    
                                    let calSuccess = false;
                                    let calErrorDetail = "";
                                    
                                    if (!process.env.APPS_SCRIPT_URL) {
                                        calErrorDetail = "APPS_SCRIPT_URL is missing in environment variables.";
                                        console.error(calErrorDetail);
                                    } else {
                                        try {
                                            const scriptResponse = await fetch(process.env.APPS_SCRIPT_URL, {
                                                method: 'POST',
                                                headers: {
                                                    'Content-Type': 'application/json'
                                                },
                                                body: JSON.stringify({
                                                    action: 'createCalendarEvent',
                                                    title: title,
                                                    startTime: startTime,
                                                    endTime: endTime,
                                                    description: description || ""
                                                })
                                            });
                                            
                                            const result = await scriptResponse.json();
                                            if (result.success) {
                                                calSuccess = true;
                                                console.log("Event scheduled successfully via Apps Script!");
                                            } else {
                                                calErrorDetail = result.error || "Unknown error from Apps Script";
                                                console.error("Failed to schedule event via Apps Script:", calErrorDetail);
                                            }
                                        } catch (calErr: any) {
                                            calErrorDetail = calErr.message;
                                            console.error("Failed to fetch Apps Script URL for calendar:", calErrorDetail);
                                        }
                                    }
                                    
                                    // Append the exact model response to history (which includes thought_signature and call id)
                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({
                                            role: "model",
                                            parts: [{ functionCall: { name: call.name, args: call.args } }]
                                        });
                                    }
                                    
                                    // Append the function response
                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { success: calSuccess, detail: calSuccess ? "Event scheduled successfully" : `Failed to schedule event: ${calErrorDetail}` }, id: call.id } }]
                                    });
                                } else if (call.name === "searchGoogleContact") {
                                    const args = call.args as any;
                                    const { name } = args;
                                    
                                    console.log(`Searching Google Contacts for: ${name}...`);
                                    
                                    let contactSuccess = false;
                                    let contactPhone = "";
                                    let contactError = "";
                                    
                                    if (!process.env.APPS_SCRIPT_URL) {
                                        contactError = "APPS_SCRIPT_URL not configured in Render.";
                                    } else {
                                        try {
                                            const scriptReq = await fetch(process.env.APPS_SCRIPT_URL, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({
                                                    action: 'searchContact',
                                                    name: name
                                                })
                                            });
                                            const scriptRes = await scriptReq.json();
                                            if (scriptRes.success) {
                                                contactSuccess = true;
                                                contactPhone = scriptRes.phone;
                                            } else {
                                                contactError = scriptRes.message || "Contact not found.";
                                            }
                                        } catch (err: any) {
                                            contactError = err.message;
                                        }
                                    }
                                    
                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({
                                            role: "model",
                                            parts: [{ functionCall: { name: call.name, args: call.args } }]
                                        });
                                    }
                                    
                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { success: contactSuccess, detail: contactSuccess ? `Found phone number: ${contactPhone}` : `Failed: ${contactError}` }, id: call.id } }]
                                    });
                                } else if (call.name === "sendWhatsAppMessage") {
                                    const args = call.args as any;
                                    const { phoneNumber, message } = args;
                                    
                                    console.log(`Sending WhatsApp message to ${phoneNumber}...`);
                                    
                                    let sendSuccess = false;
                                    let sendError = "";
                                    
                                    try {
                                        let cleanNumber = phoneNumber.replace(/[^0-9]/g, "");
                                        if (cleanNumber.length === 10) {
                                            cleanNumber = "91" + cleanNumber;
                                        }
                                        const jid = `${cleanNumber}@s.whatsapp.net`;
                                        await sock.sendMessage(jid, { text: message });
                                        sendSuccess = true;
                                    } catch (err: any) {
                                        sendError = err.message;
                                    }
                                    
                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({
                                            role: "model",
                                            parts: [{ functionCall: { name: call.name, args: call.args } }]
                                        });
                                    }
                                    
                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { success: sendSuccess, detail: sendSuccess ? "Message sent successfully!" : `Failed to send: ${sendError}` }, id: call.id } }]
                                    });
                                } else if (["findGoogleSheet", "createGoogleSheet", "readGoogleSheet", "appendGoogleSheet", "updateGoogleSheet"].includes(call.name as string)) {
                                    console.log(`Executing Sheets tool: ${call.name}...`);
                                    let sheetSuccess = false;
                                    let sheetDetail: any = "Unknown error";
                                    
                                    if (!process.env.APPS_SCRIPT_URL) {
                                        sheetDetail = "APPS_SCRIPT_URL is missing in environment variables.";
                                    } else {
                                        try {
                                            const payload: any = { action: call.name };
                                            if (call.args) {
                                                Object.assign(payload, call.args);
                                            }
                                            
                                            const scriptResponse = await fetch(process.env.APPS_SCRIPT_URL, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify(payload)
                                            });
                                            
                                            const result = await scriptResponse.json();
                                            if (result.success) {
                                                sheetSuccess = true;
                                                sheetDetail = result.data || result.message || "Operation successful.";
                                            } else {
                                                sheetDetail = result.error || "Failed Google Sheets operation.";
                                            }
                                        } catch (err: any) {
                                            sheetDetail = err.message;
                                        }
                                    }
                                    
                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({
                                            role: "model",
                                            parts: [{ functionCall: { name: call.name, args: call.args } }]
                                        });
                                    }
                                    
                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { success: sheetSuccess, detail: sheetDetail }, id: call.id } }]
                                    });
                                } else if (call.name === "saveMemory") {
                                    console.log(`Saving vector memory...`);
                                    const args = call.args as any;
                                    let memSuccess = false;
                                    let memError = "";
                                    try {
                                        if (!vectorMemoryCollection) throw new Error("Vector Memory DB not connected");
                                        const embedRes = await ai.models.embedContent({
                                            model: "gemini-embedding-2",
                                            contents: args.fact,
                                            config: { outputDimensionality: 768 }
                                        });
                                        const embedding = embedRes.embeddings?.[0]?.values;
                                        if (!embedding) throw new Error("Failed to generate embedding");
                                        
                                        await vectorMemoryCollection.insertOne({
                                            text: args.fact,
                                            embedding: embedding,
                                            createdAt: new Date()
                                        });
                                        memSuccess = true;
                                    } catch (err: any) {
                                        memError = err.message;
                                    }
                                    
                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({
                                            role: "model",
                                            parts: [{ functionCall: { name: call.name, args: call.args } }]
                                        });
                                    }
                                    
                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { success: memSuccess, detail: memSuccess ? "Memory saved successfully!" : `Failed: ${memError}` }, id: call.id } }]
                                    });
                                } else if (call.name === "searchMemory") {
                                    const args = call.args as any;
                                    console.log(`Searching vector memory for: ${args.query}...`);
                                    let searchSuccess = false;
                                    let retrievedMemories = "";
                                    let searchError = "";
                                    try {
                                        if (!vectorMemoryCollection) throw new Error("Vector Memory DB not connected");
                                        const embedRes = await ai.models.embedContent({
                                            model: "gemini-embedding-2",
                                            contents: args.query,
                                            config: { outputDimensionality: 768 }
                                        });
                                        const queryVector = embedRes.embeddings?.[0]?.values;
                                        if (!queryVector) throw new Error("Failed to generate embedding");
                                        
                                        const pipeline = [
                                            {
                                                $vectorSearch: {
                                                    index: "vector_index",
                                                    path: "embedding",
                                                    queryVector: queryVector,
                                                    numCandidates: 10,
                                                    limit: 3
                                                }
                                            },
                                            {
                                                $project: { text: 1, score: { $meta: "vectorSearchScore" } }
                                            }
                                        ];
                                        
                                        const results = await vectorMemoryCollection.aggregate(pipeline).toArray();
                                        if (results.length > 0) {
                                            retrievedMemories = results.map(r => r.text).join("\n");
                                            searchSuccess = true;
                                        } else {
                                            retrievedMemories = "No relevant memories found.";
                                            searchSuccess = true;
                                        }
                                    } catch (err: any) {
                                        searchError = err.message;
                                    }
                                    
                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({
                                            role: "model",
                                            parts: [{ functionCall: { name: call.name, args: call.args } }]
                                        });
                                    }
                                    
                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { success: searchSuccess, detail: searchSuccess ? retrievedMemories : `Failed: ${searchError}` }, id: call.id } }]
                                    });
                                } else if (call.name === "searchWeb") {
                                    const args = call.args as any;
                                    console.log(`Searching the web for: ${args.query}...`);
                                    let searchSuccess = false;
                                    let searchResult = "";
                                    try {
                                        const searchResponse = await ai.models.generateContent({
                                            model: "gemini-2.5-flash",
                                            contents: `Search the web for: "${args.query}". Provide a concise and highly factual summary of the search results. DO NOT format this as a conversation, just output the raw facts so I can parse them.`,
                                            config: {
                                                tools: [{ googleSearch: {} }]
                                            }
                                        });
                                        searchResult = searchResponse.text || "No results found.";
                                        searchSuccess = true;
                                    } catch (err: any) {
                                        console.error("Web Search Error:", err);
                                        searchResult = `Web Search failed: ${err.message}`;
                                    }

                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({
                                            role: "model",
                                            parts: [{ functionCall: { name: call.name, args: call.args } }]
                                        });
                                    }

                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { success: searchSuccess, result: searchResult }, id: call.id } }]
                                    });
                                } else if (call.name === "getUserLocation") {
                                    console.log(`Pinging phone for live location of ${remoteJid}...`);
                                    
                                    const locationPromise = new Promise<{lat: number, lng: number} | null>((resolve) => {
                                        globalPendingLocationResolve = resolve;
                                        setTimeout(() => {
                                            if (globalPendingLocationResolve === resolve) {
                                                globalPendingLocationResolve = null;
                                                resolve(null);
                                            }
                                        }, 15000); // 15s timeout
                                    });

                                    try {
                                        await axios.post('https://ntfy.sh/yatin_rhea_loc_trigger', `GET_LOCATION`, {
                                            headers: { 'Title': 'Location Ping' }
                                        });
                                        
                                        const loc = await locationPromise;
                                        
                                        if (response.candidates && response.candidates.length > 0) {
                                            contents.push(response.candidates[0].content);
                                        } else {
                                            contents.push({ role: "model", parts: [{ functionCall: { name: call.name, args: call.args } }] });
                                        }

                                        if (loc) {
                                            contents.push({
                                                role: "user",
                                                parts: [{ functionResponse: { name: call.name, response: { success: true, coordinates: `${loc.lat},${loc.lng}`, instruction: "Use these coordinates with searchMap if you need to find places nearby." }, id: call.id } }]
                                            });
                                        } else {
                                            contents.push({
                                                role: "user",
                                                parts: [{ functionResponse: { name: call.name, response: { success: false, detail: "Phone did not respond within 15 seconds. It may be offline or asleep." }, id: call.id } }]
                                            });
                                        }
                                    } catch (err: any) {
                                        if (response.candidates && response.candidates.length > 0) { contents.push(response.candidates[0].content); }
                                        else { contents.push({ role: "model", parts: [{ functionCall: { name: call.name, args: call.args } }] }); }
                                        contents.push({
                                            role: "user",
                                            parts: [{ functionResponse: { name: call.name, response: { success: false, detail: `Error pinging phone: ${err.message}` }, id: call.id } }]
                                        });
                                    }
                                } else if (call.name === "searchMap") {
                                    const args = call.args as any;
                                    console.log(`Executing searchMap for ${args?.query}...`);
                                    try {
                                        const searchResponse = await ai.models.generateContent({
                                            model: "gemini-3.1-flash-lite",
                                            contents: [
                                                { role: "user", parts: [{ text: `Search Google Maps for '${args?.query}'. If the query is coordinates, identify the exact location, address, and nearby landmarks. Summarize the best results clearly.` }] }
                                            ],
                                            config: {
                                                tools: [{ googleMaps: {} }]
                                            }
                                        });
                                        const output = searchResponse.text || "No results from Maps.";
                                        
                                        contents.push(response.candidates[0].content);
                                        contents.push({
                                            role: "user",
                                            parts: [{ functionResponse: { name: call.name, response: { result: output } } }]
                                        });
                                    } catch (err: any) {
                                        contents.push(response.candidates[0].content);
                                        contents.push({
                                            role: "user",
                                            parts: [{ functionResponse: { name: call.name, response: { error: err.message } } }]
                                        });
                                    }
                                } else if (call.name === "triggerDailyBriefing") {
                                    console.log(`Executing triggerDailyBriefing...`);
                                    try {
                                        const result = await runDailyBriefing(sock, false); // Don't send directly, return it to Rhea
                                        contents.push(response.candidates[0].content);
                                        contents.push({
                                            role: "user",
                                            parts: [{ functionResponse: { name: call.name, response: { briefing: result } } }]
                                        });
                                    } catch (err: any) {
                                        contents.push(response.candidates[0].content);
                                        contents.push({
                                            role: "user",
                                            parts: [{ functionResponse: { name: call.name, response: { error: err.message } } }]
                                        });
                                    }
                                } else if (call.name === "readChatHistory") {
                                    console.log(`Executing readChatHistory...`);
                                    try {
                                        const args = call.args as any;
                                        let targetJid = args.targetJid;
                                        
                                        // WhatsApp Multi-Device translates incoming chats to @lid in the database.
                                        // We map the known phone JIDs to their respective @lid so the query succeeds.
                                        if (targetJid.includes("917744845094")) targetJid = "40789321191437@lid"; // Pranjal
                                        else if (targetJid.includes("919373278178")) targetJid = "122423764594882@lid"; // Pranjal
                                        else if (targetJid.includes("919324404314")) targetJid = "241510339620878@lid"; // Mamma
                                        else if (targetJid.includes("122423764594882")) targetJid = "122423764594882@lid"; // Pranjal direct LID fallback
                                        
                                        let historyText = "No history found or database not connected.";
                                        if (chatHistoryCollection) {
                                            const limit = Math.min(args.limit || 10, 50);
                                            const history = await chatHistoryCollection.find({ remoteJid: targetJid })
                                                .sort({ timestamp: -1 })
                                                .limit(limit)
                                                .toArray();
                                            
                                            // Reverse to get chronological order
                                            history.reverse();
                                            historyText = history.map(m => `[${new Date(m.timestamp).toLocaleString()}] ${m.role === 'user' ? 'User' : 'Reflex'}: ${m.content}`).join('\n');
                                        }
                                        
                                        contents.push(response.candidates[0].content);
                                        contents.push({
                                            role: "user",
                                            parts: [{ functionResponse: { name: call.name, response: { history: historyText } } }]
                                        });
                                    } catch (err: any) {
                                        contents.push(response.candidates[0].content);
                                        contents.push({
                                            role: "user",
                                            parts: [{ functionResponse: { name: call.name, response: { error: err.message } } }]
                                        });
                                    }
                                } else if (call.name === "messageAdmin") {
                                    console.log(`Executing messageAdmin...`);
                                    try {
                                        const args = call.args as any;
                                        const type = args.type || 'text';
                                        
                                        if (type === 'audio') {
                                            // Send text intro first
                                            await sock.sendMessage(OWNER_NUMBER, { text: `*[Voice Note from ${vipName}]:*` });
                                            
                                            // Then send the voice note
                                            const audioBuffer = await generateVoiceNote({
                                                text: args.content,
                                                voiceName: args.voiceName || "ar-XA-Chirp3-HD-Kore",
                                                languageCode: "ar-XA"
                                            });
                                            try {
                                                await sock.sendMessage(OWNER_NUMBER, {
                                                    audio: audioBuffer,
                                                    ptt: true,
                                                    mimetype: 'audio/ogg; codecs=opus'
                                                });
                                            } catch (sendErr) {
                                                console.error("Error sending voice note audio to admin:", sendErr);
                                            }
                                        } else {
                                            await sock.sendMessage(OWNER_NUMBER, { text: `*[Message from ${vipName}]:*\n${args.content}` });
                                        }

                                        contents.push(response.candidates[0].content);
                                        contents.push({
                                            role: "user",
                                            parts: [{ functionResponse: { name: call.name, response: { success: true } } }]
                                        });
                                    } catch (err: any) {
                                        console.error(`messageAdmin Error:`, err);
                                        contents.push(response.candidates[0].content);
                                        contents.push({
                                            role: "user",
                                            parts: [{ functionResponse: { name: call.name, response: { error: err.message } } }]
                                        });
                                    }
                                } else if (call.name === "sendVoiceNote") {
                                    console.log(`Executing sendVoiceNote...`);
                                    try {
                                        const args = call.args as any;
                                        if (args.text) {
                                            sentVoiceNoteScript = args.text;
                                        }
                                        
                                        let targetJid = remoteJid;
                                        if (args.targetPhoneNumber) {
                                            let cleanNumber = args.targetPhoneNumber.replace(/[^0-9]/g, "");
                                            if (cleanNumber.length === 10) {
                                                cleanNumber = "91" + cleanNumber;
                                            }
                                            targetJid = `${cleanNumber}@s.whatsapp.net`;
                                        }

                                        const audioBuffer = await generateVoiceNote({
                                            text: args.text,
                                            voiceName: args.voiceName,
                                            languageCode: args.languageCode
                                        });

                                        try {
                                            await sock.sendMessage(targetJid, {
                                                audio: audioBuffer,
                                                ptt: true, // Native Voice Note format
                                                mimetype: 'audio/ogg; codecs=opus'
                                            });
                                        } catch (sendErr) {
                                            console.error("Error sending voice note audio:", sendErr);
                                            // Even if Baileys throws an error here (like MongoNetworkError), 
                                            // the message often still goes through to WhatsApp, so we will still mark it success.
                                        }

                                        // --- NEW: ESP32 BROADCAST ---
                                        if (esp32Clients && esp32Clients.size > 0) {
                                            try {
                                                // Generate MP3 version for ESP32
                                                const mp3Buffer = await generateVoiceNote({
                                                    text: args.text,
                                                    voiceName: args.voiceName,
                                                    languageCode: args.languageCode,
                                                    audioEncoding: "MP3"
                                                });
                                                
                                                for (const client of esp32Clients) {
                                                    if (client.readyState === WebSocket.OPEN) {
                                                        // Send state first
                                                        client.send(JSON.stringify({ action: 'display', state: 'speaking', text: args.text.substring(0, 50) + "..." }));
                                                        // Send binary audio
                                                        client.send(mp3Buffer);
                                                    }
                                                }
                                            } catch (espErr) {
                                                console.error("Error sending voice note to ESP32:", espErr);
                                            }
                                        }
                                        // --- END NEW ---
                                        
                                        if (targetJid === remoteJid) {
                                            voiceNoteSent = true;
                                        }

                                        contents.push(response.candidates[0].content);
                                        contents.push({
                                            role: "user",
                                            parts: [{ functionResponse: { name: call.name, response: { success: true } } }]
                                        });
                                    } catch (err: any) {
                                        console.error("sendVoiceNote Error:", err);
                                        contents.push(response.candidates[0].content);
                                        contents.push({
                                            role: "user",
                                            parts: [{ functionResponse: { name: call.name, response: { error: err.message } } }]
                                        });
                                    }
                                } else {
                                    console.log(`Executing MCP Tool (or Unknown): ${call.name}...`);
                                    let toolSuccess = false;
                                    let toolResult: any = "";
                                    
                                    try {
                                        const mcpTools = getMcpToolsCache();
                                        const isMcpTool = mcpTools.some((t: any) => t.name === call.name);
                                        
                                        if (isMcpTool) {
                                            toolResult = await executeMcpTool(call.name as string, call.args);
                                            toolSuccess = true;
                                        } else {
                                            throw new Error(`Unknown function call: ${call.name}`);
                                        }
                                    } catch (err: any) {
                                        console.error(`Error executing ${call.name}:`, err.message);
                                        toolResult = { error: err.message };
                                    }

                                    if (response.candidates && response.candidates.length > 0) {
                                        contents.push(response.candidates[0].content);
                                    } else {
                                        contents.push({ role: "model", parts: [{ functionCall: { name: call.name, args: call.args } }] });
                                    }

                                    contents.push({
                                        role: "user",
                                        parts: [{ functionResponse: { name: call.name, response: { success: toolSuccess, result: toolResult }, id: call.id } }]
                                    });
                                }
                            }
                            
                            // Let the model generate the final text reply to the user now that the function finished
                            response = await ai.models.generateContent({
                                model: 'gemini-3.1-flash-lite',
                                contents: contents,
                                config: {
                                    systemInstruction: rheaSystemPrompt,
                                    tools: [ toolConfig ]
                                }
                            });
                        }

                        aiResponseText = response.text || "I'm sorry, I couldn't process that right now.";
                    } catch (aiErr: any) {
                        console.error("Gemini API Error:", aiErr.message);
                        aiResponseText = "Sorry, my brain (Gemini) is having trouble responding right now.";
                    }

                    // 4. Save Model response to History
                    if (chatHistoryCollection && remoteJid) {
                        let finalSavedContent = aiResponseText;
                        if (sentVoiceNoteScript) {
                            finalSavedContent = `[Rhea Voice Note Transcript: "${sentVoiceNoteScript}"] ${finalSavedContent}`;
                        }
                        await chatHistoryCollection.insertOne({
                            remoteJid,
                            role: "model",
                            content: finalSavedContent.trim(),
                            timestamp: new Date()
                        });
                    }

                    // 5. Send back to WhatsApp
                    if (remoteJid && !voiceNoteSent) {
                        await sock.sendMessage(remoteJid, { text: aiResponseText }, { quoted: msg });
                        console.log(`Sent Rhea response to ${remoteJid}`);
                    } else if (remoteJid && voiceNoteSent) {
                        console.log(`Suppressed text response to ${remoteJid} because a voice note was sent.`);
                    }
                } catch (e: any) {
                    console.error("Error processing incoming message:", e.message);
                }
            }
        });

    } catch (error: any) {
        console.error("Failed to connect WhatsApp:", error.message);
        console.error("Will retry in 5 seconds...");
        await new Promise(resolve => setTimeout(resolve, 5000));
        connectWhatsApp();
    }
}
