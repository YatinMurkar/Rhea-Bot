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
const OWNER_NUMBER = "917744845094@s.whatsapp.net";
const ADMIN_NUMBERS = new Set(["917057962045", "122423764594882", "917744845094", "40789321191437"]);

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

// --- START THE SERVER IMMEDIATELY ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/esp32' });

// Keep track of connected ESP32 clients
const esp32Clients = new Set<WebSocket>();

wss.on('connection', (ws: WebSocket) => {
    console.log('ESP32 connected via WebSocket');
    esp32Clients.add(ws);
    
    ws.send(JSON.stringify({ action: 'display', state: 'idle', text: 'Connected to Rhea' }));

    ws.on('message', async (message: Buffer) => {
        console.log('Received audio from ESP32, length:', message.length);
        // Phase 2: Process Audio
    });

    ws.on('close', () => {
        console.log('ESP32 disconnected');
        esp32Clients.delete(ws);
    });
});

server.listen(PORT, () => {
    console.log(`Express and WebSocket server running on port ${PORT}`);
    console.log('Now connecting to MongoDB and starting WhatsApp bot...');
    startBot();
});

// Native MongoDB Auth State logic
const useMongoDBAuthState = async (collection: any) => {
    const writeData = async (data: any, id: string) => {
        const informationToStore = JSON.stringify(data, BufferJSON.replacer);
        await collection.updateOne({ _id: id }, { $set: { data: informationToStore } }, { upsert: true });
    };

    const readData = async (id: string) => {
        try {
            const data = await collection.findOne({ _id: id });
            if (data && data.data) {
                return JSON.parse(data.data, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id: string) => {
        try {
            await collection.deleteOne({ _id: id });
        } catch (error) { }
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type: string, ids: string[]) => {
                    const data: { [key: string]: any } = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data: any) => {
                    const tasks: Promise<any>[] = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        }
    };
};

// --- DAILY BRIEFING LOGIC ---
export async function runDailyBriefing(sock: any, sendToUser: boolean = true): Promise<string> {
    console.log("Triggering Proactive Daily Morning Briefing...");
    try {
        // 1. Get location
        globalPendingLocationResolve = null;
        const locationPromise = new Promise<{lat: number, lng: number} | null>((resolve, reject) => {
            globalPendingLocationResolve = resolve;
            setTimeout(() => {
                globalPendingLocationResolve = null;
                reject(new Error("Timeout waiting for location from phone"));
            }, 30000);
        });
        
        console.log("Pinging phone for location...");
        await axios.post('https://ntfy.sh/yatin_rhea_loc_trigger', 'GET_LOCATION', {
            headers: { 'Title': 'Rhea Location Request' }
        });
        
        const location = await locationPromise;
        if (!location) {
            throw new Error("Failed to get location");
        }
        console.log(`Got location for briefing: ${location.lat}, ${location.lng}`);
        
        // 2. Fetch reminders
        let activeReminders: any[] = [];
        if (remindersCollection) {
            activeReminders = await remindersCollection.find({ creatorJid: OWNER_NUMBER }).toArray();
        }
        const remindersText = activeReminders.length > 0 
            ? activeReminders.map(r => `- ${new Date(r.triggerTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}: ${r.message}`).join('\n')
            : "No reminders for today.";

        // 2a. Convert coordinates to City Name using Gemini 3.1 Flash Lite (Maps Engine)
        const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        let cityName = "Unknown Location";
        try {
            const mapResponse = await ai.models.generateContent({
                model: "gemini-3.1-flash-lite",
                contents: `Search Google Maps for coordinates: ${location.lat}, ${location.lng}. What is the name of the city, town, or neighborhood? Return ONLY the name of the place.`,
                config: { tools: [{ googleMaps: {} }] }
            });
            cityName = mapResponse.text?.trim() || "Unknown Location";
            console.log(`Resolved location via Maps: ${cityName}`);
        } catch (e) {
            console.error("Map resolution failed", e);
        }

        // 2b. Fetch Weather & News using Gemini 2.5 Flash (Web Search Engine)
        let webData = "";
        try {
            const webResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: `Search the web for the current weather and 3 top news headlines for: ${cityName}. Return the raw facts concisely.`,
                config: { tools: [{ googleSearch: {} }] }
            });
            webData = webResponse.text || "";
            console.log("Fetched web data for briefing.");
        } catch (e) {
            console.error("Web search failed", e);
        }

        // 3. Generate Briefing with Gemini 3.1 Flash Lite (Core Engine)
        const briefingPrompt = `You are Rhea, a female AI assistant. Generate my daily morning briefing.
My current location is: ${cityName}. 
Here is the live Weather and News data:
${webData}

My current reminders are:
${remindersText}

Format the response EXACTLY like this structure with emojis:

🌅 *Good Morning, Pranjal!*
Here is your daily briefing to start the day right.

🌡️ *Local Weather (${cityName})*
- Current Temp: [temp]
- Forecast: [short 1-sentence forecast]

📰 *Top News*
- *[Headline 1]*: [One sentence summary]
- *[Headline 2]*: [One sentence summary]
- *[Headline 3]*: [One sentence summary]

⏰ *Your Reminders*
[List of reminders, or "You have a clear slate today!"]

Have a fantastic day! ⚡`;

        const response = await ai.models.generateContent({
            model: "gemini-3.1-flash-lite",
            contents: briefingPrompt,
            config: {
                systemInstruction: "You are Rhea, a warm and graceful AI assistant. You generate structured, beautiful, and highly readable morning briefings using emojis and markdown formatting."
            }
        });
        
        const briefingText = response.text || "";
        if (briefingText && sendToUser) {
            await sock.sendMessage(OWNER_NUMBER, { text: briefingText });
            console.log("Morning briefing sent successfully.");
        }
        return briefingText;

    } catch (error: any) {
        console.error("Failed to generate/send morning briefing:", error);
        return "Failed to generate briefing: " + error.message;
    }
}

function initDailyBriefing(sock: any) {
    // Schedule for 7:30 AM IST every day
    cron.schedule('30 7 * * *', async () => {
        await runDailyBriefing(sock, true);
    }, {
        timezone: "Asia/Kolkata"
    });
    console.log("Daily Morning Briefing scheduled for 07:30 AM IST.");
}

// --- MongoDB collection references (set once in startBot) ---
let authCollection: any = null;

// --- CONNECT MONGODB (runs ONCE on boot) ---
async function startBot() {
    try {
        console.log("Connecting to MongoDB...");
        const mongoClient = new MongoClient(MONGODB_URI as string, {
            tls: true,
            tlsAllowInvalidCertificates: true,
            serverSelectionTimeoutMS: 15000,
            autoSelectFamily: false,
            family: 4
        } as any);
        // Infinite retry with exponential backoff - never give up
        let connected = false;
        let attempt = 0;
        while (!connected) {
            try {
                await mongoClient.connect();
                connected = true;
            } catch (err: any) {
                attempt++;
                const delay = Math.min(3000 * Math.pow(2, attempt - 1), 60000);
                console.error(`MongoDB connection failed (attempt ${attempt}), retrying in ${delay/1000}s:`, err.message);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        const db = mongoClient.db("whatsapp_bot");
        authCollection = db.collection("auth_info");
        chatHistoryCollection = db.collection("chat_history");
        vectorMemoryCollection = db.collection("vector_memory");
        remindersCollection = db.collection("reminders");
        console.log("Connected to MongoDB for auth state & chat history.");

        // Initialize MCP Tools on boot
        await initializeMcpTools();

        // Now start WhatsApp connection (separate from MongoDB)
        await connectWhatsApp();

    } catch (error: any) {
        console.error("Failed to connect MongoDB:", error.message);
        console.error("Starting WhatsApp WITHOUT MongoDB (QR-only mode)...");
        // Even if MongoDB fails, still try to connect WhatsApp for QR
        await connectWhatsApp();
    }
}

// --- CONNECT WHATSAPP (can be called repeatedly without touching MongoDB) ---
let qrRetryCount = 0;
const MAX_QR_RETRIES = 50;

async function connectWhatsApp() {
    try {
        let state: any;
        let saveCreds: () => Promise<void>;
        
        // Flag to track if we are using temporary in-memory auth
        let usingInMemoryAuth = false;

        let existingCreds = null;
        if (authCollection) {
            const data = await authCollection.findOne({ _id: 'creds' });
            if (data && data.data) {
                existingCreds = true;
            }
        }

        if (authCollection && existingCreds) {
            const result = await useMongoDBAuthState(authCollection);
            state = result.state;
            saveCreds = result.saveCreds;
            console.log("Auth state loaded from MongoDB.");
            qrRetryCount = 0;
        } else {
            // No MongoDB creds — use pure in-memory creds (QR-only mode)
            usingInMemoryAuth = true;
            qrRetryCount++;
            if (qrRetryCount > MAX_QR_RETRIES) {
                console.log(`QR retry limit (${MAX_QR_RETRIES}) reached. Pausing for 5 minutes...`);
                await new Promise(r => setTimeout(r, 5 * 60 * 1000));
                qrRetryCount = 0;
            }
            const { state: memState, saveCreds: memSaveCreds } = await useMultiFileAuthState('./temp_auth');
            state = memState;
            saveCreds = memSaveCreds;
            console.log("No MongoDB auth found. Using temporary in-memory auth for QR generation...");
        }

        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }) as any,
            printQRInTerminal: false,
            auth: state,
            browser: Browsers.ubuntu('Chrome'),
            generateHighQualityLinkPreview: true,
        });

        sock.ev.on('creds.update', saveCreds);
        
        // --- START REMINDER CRON LOOP (only once) ---
        if (!(globalThis as any).__reminderLoopStarted) {
            (globalThis as any).__reminderLoopStarted = true;
            setInterval(async () => {
                if (!botReady || !remindersCollection || !sock) return;
                try {
                    const now = new Date();
                    const dueReminders = await remindersCollection.find({ triggerTime: { $lte: now } }).toArray();
                    
                    for (const reminder of dueReminders) {
                        try {
                            await sock.sendMessage(reminder.remoteJid, { text: `⏰ *REMINDER:* ${reminder.message}` });
                            await remindersCollection.deleteOne({ _id: reminder._id });
                            console.log(`Fired and deleted reminder for ${reminder.remoteJid}`);
                        } catch (sendErr) {
                            console.error("Failed to send due reminder:", sendErr);
                        }
                    }
                } catch (cronErr) {
                    console.error("Error in reminder interval:", cronErr);
                }
            }, 60000);
        }
            
        initDailyBriefing(sock);

        sock.ev.on('connection.update', (update: any) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                if (!qrScanned) {
                    latestQR = qr;
                    console.log('='.repeat(50));
                    console.log('NEW QR CODE - Scan at: https://rhea-bot-8n8v.onrender.com/qr');
                    console.log('='.repeat(50));
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 428;
                console.log('Connection closed, statusCode:', statusCode, ', reconnecting:', shouldReconnect);
                botReady = false;
                qrScanned = false;
                if (shouldReconnect) {
                    // Reconnect WhatsApp ONLY — don't touch MongoDB
                    if (statusCode === 408) {
                        setTimeout(() => connectWhatsApp(), 5000);
                    } else {
                        setTimeout(() => connectWhatsApp(), 1000);
                    }
                } else {
                    console.log('Session expired/logged out (statusCode:', statusCode, '). Clearing auth for fresh QR...');
                    
                    if (usingInMemoryAuth) {
                        try {
                            const fs = require('fs');
                            const path = require('path');
                            fs.rmSync(path.join(__dirname, 'temp_auth'), { recursive: true, force: true });
                            console.log('Cleared temporary in-memory auth.');
                        } catch (e) {}
                    }

                    if (authCollection) {
                        authCollection.deleteOne({ _id: 'creds' }).then(() => {
                            console.log('Auth creds cleared from MongoDB. Preserving other keys. Restarting WhatsApp for fresh QR...');
                            setTimeout(() => connectWhatsApp(), 2000); // add slight delay to prevent instant loop
                        }).catch(e => console.error("Error clearing creds:", e));
                    } else {
                        console.log('No MongoDB — restarting WhatsApp with fresh creds...');
                        setTimeout(() => connectWhatsApp(), 2000);
                    }
                }
            } else if (connection === 'open') {
                botReady = true;
                latestQR = null;
                qrScanned = true;
                console.log('='.repeat(50));
                console.log('WhatsApp Client is READY! Bot is fully operational.');
                console.log('='.repeat(50));
                
                if (usingInMemoryAuth && authCollection) {
                    console.log('Migrating fresh in-memory credentials to MongoDB...');
                    // Read from temp_auth folder and write to MongoDB
                    const fs = require('fs');
                    const path = require('path');
                    const tempAuthDir = path.join(__dirname, 'temp_auth');
                    if (fs.existsSync(tempAuthDir)) {
                        const files = fs.readdirSync(tempAuthDir);
                        for (const file of files) {
                            if (file.endsWith('.json')) {
                                const data = fs.readFileSync(path.join(tempAuthDir, file), 'utf8');
                                const key = file.replace('.json', '');
                                // Note: We might need to map 'creds.json' to 'creds'
                                const dbKey = key === 'creds' ? 'creds' : key;
                                authCollection.updateOne({ _id: dbKey }, { $set: { data: data } }, { upsert: true }).catch(console.error);
                            }
                        }
                        console.log('Successfully migrated credentials to MongoDB. Restarting to use MongoDB auth...');
                        // Restart the whole node process so the next boot uses MongoDB natively
                        try { fs.rmSync(tempAuthDir, { recursive: true, force: true }); } catch (e) {}
                        setTimeout(() => process.exit(0), 1000);
                    }
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg.message) continue;
                
                try {
                    const fromMe = msg.key.fromMe;
                    const remoteJid = msg.key.remoteJid;
                    const pushName = msg.pushName || '';
                    const isGroup = remoteJid?.endsWith('@g.us');
                    
                    let body = '';
                    let hasMedia = false;
                    let mediaMimeType = null;
                    let mediaData: string | null = null;
                    let fileLengthStr = null;
                    
                    const messageType = Object.keys(msg.message)[0];
                    if (messageType === 'conversation') body = msg.message?.conversation;
                    else if (messageType === 'extendedTextMessage') body = msg.message?.extendedTextMessage?.text;
                    else if (['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'].includes(messageType)) {
                        const msgDetails = (msg.message as any)[messageType];
                        body = msgDetails?.caption || '';
                        hasMedia = true;
                        mediaMimeType = msgDetails?.mimetype;
                        fileLengthStr = msgDetails?.fileLength;
                        
                        // 20MB limit
                        const sizeLimit = 20 * 1024 * 1024;
                        const fileSize = fileLengthStr ? Number(fileLengthStr) : 0;
                        
                        if (fileSize > 0 && fileSize <= sizeLimit) {
                            console.log(`Downloading media for message ${msg.key.id} (Size: ${fileSize} bytes)...`);
                            try {
                                const buffer = await downloadMediaMessage(
                                    msg,
                                    'buffer',
                                    { },
                                    { 
                                        logger: pino({ level: 'silent' }) as any,
                                        reuploadRequest: sock.updateMediaMessage
                                    }
                                );
                                mediaData = buffer.toString('base64');
                                console.log('Successfully downloaded and encoded media.');
                            } catch (err: any) {
                                console.error('Failed to download media:', err.message);
                            }
                        } else if (fileSize > sizeLimit) {
                            console.log(`Media size (${fileSize} bytes) exceeds 20MB limit. Skipping download.`);
                        }
                    }

                    const payload = {
                        from: remoteJid,
                        author: remoteJid,
                        body: body,
                        name: pushName,
                        messageId: msg.key.id,
                        isGroup: isGroup,
                        hasMedia: hasMedia,
                        mediaMimeType: mediaMimeType,
                        mediaData: mediaData
                    };

                    // Extract bare number (handle groups where remoteJid is the group ID and participant is the sender)
                    const actualSenderJid = isGroup ? msg.key.participant : remoteJid;
                    const senderBareNumber = actualSenderJid ? actualSenderJid.replace(/@.*$/, "").split(":")[0] : "";
                    
                    // Admin check for slash commands: true if fromMe OR sender is a known admin number
                    const isSlashAdmin = fromMe || ADMIN_NUMBERS.has(senderBareNumber);

                    // --- SLASH COMMAND INTERCEPTION ---
                    if (body && body.startsWith('/')) {
                        const slashArgs = body.slice(1).trim().split(/ +/);
                        const slashCommand = slashArgs.shift()?.toLowerCase();
                        const slashText = slashArgs.join(" ");

                        // --- NATIVE COMMANDS (No AI, instant execution) ---
                        if (slashCommand === 'ping') {
                            await sock.sendMessage(remoteJid, { text: '✨ Pong! Rhea is online and ready.' });
                            continue;
                        }

                        if (slashCommand === 'clear') {
                            if (chatHistoryCollection && remoteJid) {
                                await chatHistoryCollection.deleteMany({ remoteJid });
                            }
                            await sock.sendMessage(remoteJid, { text: '🧹 Conversation memory cleared. Fresh start!' });
                            continue;
                        }

                        if (slashCommand === 'help') {
                            const helpText = `✨ *Rhea Slash Commands*\n\n` +
                                `📌 *General*\n` +
                                `/ping - Check if Rhea is alive\n` +
                                `/clear - Clear your chat memory\n` +
                                `/help - Show this list\n` +
                                `/summarize - Summarize recent chat\n\n` +
                                `🧠 *AI-Powered*\n` +
                                `/reminder [text] - Set a reminder\n` +
                                `/calendar [query] - Check/add calendar events\n` +
                                `/notion [query] - Search/add to Notion\n` +
                                `/todo [task] - Add to To-Do list in Notion\n` +
                                `/idea [text] - Save idea to Notion Ideas\n` +
                                `/search [query] - Search the web\n` +
                                `/map [location] - Search Google Maps\n` +
                                `/email [address] [message] - Send an email\n\n` +
                                `🔒 *Admin Only*\n` +
                                `/send [number] [message] - Message someone\n` +
                                `/briefing - Force daily briefing\n` +
                                `/status - Bot health and stats\n` +
                                `/logs - Recent errors\n` +
                                `/mute [name/number/group] - Mute a chat\n` +
                                `/unmute [name/number/group] - Unmute a chat\n` +
                                `/mutelist - Show muted chats\n\n` +
                                `_Any message without / works as normal conversation._`;
                            await sock.sendMessage(remoteJid, { text: helpText });
                            continue;
                        }

                        if (slashCommand === 'send') {
                            if (!isSlashAdmin) {
                                await sock.sendMessage(remoteJid, { text: '🔒 This command is admin-only.' });
                                continue;
                            }
                            const targetNumber = slashArgs[0];
                            const msgToSend = slashArgs.slice(1).join(" ");
                            if (!targetNumber || !msgToSend) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Format: /send 919876543210 Hello there!' });
                                continue;
                            }
                            try {
                                await sock.sendMessage(formatJid(targetNumber), { text: msgToSend });
                                await sock.sendMessage(remoteJid, { text: `✅ Message sent to ${targetNumber}` });
                            } catch (e: any) {
                                await sock.sendMessage(remoteJid, { text: `❌ Failed to send: ${e.message}` });
                            }
                            continue;
                        }

                        if (slashCommand === 'briefing') {
                            if (!isSlashAdmin) {
                                await sock.sendMessage(remoteJid, { text: '🔒 This command is admin-only.' });
                                continue;
                            }
                            await sock.sendMessage(remoteJid, { text: '📋 Generating briefing...' });
                            try {
                                await runDailyBriefing(sock, true);
                            } catch (e: any) {
                                await sock.sendMessage(remoteJid, { text: `❌ Briefing failed: ${e.message}` });
                            }
                            continue;
                        }

                        // --- /status (Admin Only) ---
                        if (slashCommand === 'status') {
                            if (!isSlashAdmin) {
                                await sock.sendMessage(remoteJid, { text: '🔒 This command is admin-only.' });
                                continue;
                            }
                            const uptimeSec = Math.floor((Date.now() - botStartTime) / 1000);
                            const hours = Math.floor(uptimeSec / 3600);
                            const mins = Math.floor((uptimeSec % 3600) / 60);
                            const secs = uptimeSec % 60;
                            const memUsage = process.memoryUsage();
                            const heapMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
                            const rssMB = (memUsage.rss / 1024 / 1024).toFixed(1);
                            const mutedCount = mutedJids.size;
                            const errorCount = recentErrors.length;

                            const statusText = `📊 *Rhea Status*\n\n` +
                                `*Uptime:* ${hours}h ${mins}m ${secs}s\n` +
                                `*Bot Ready:* ${botReady ? '✅ Yes' : '❌ No'}\n` +
                                `*Memory:* ${heapMB}MB heap / ${rssMB}MB RSS\n` +
                                `*MongoDB:* ${chatHistoryCollection ? '✅ Connected' : '❌ Disconnected'}\n` +
                                `*Muted Chats:* ${mutedCount}\n` +
                                `*Recent Errors:* ${errorCount}\n` +
                                `*Node:* ${process.version}`;
                            await sock.sendMessage(remoteJid, { text: statusText });
                            continue;
                        }

                        // --- /logs (Admin Only) ---
                        if (slashCommand === 'logs') {
                            if (!isSlashAdmin) {
                                await sock.sendMessage(remoteJid, { text: '🔒 This command is admin-only.' });
                                continue;
                            }
                            if (recentErrors.length === 0) {
                                await sock.sendMessage(remoteJid, { text: '✅ No recent errors! Everything is running clean.' });
                            } else {
                                const logLines = recentErrors.slice(-10).map((e, i) => {
                                    const time = new Date(e.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
                                    return `${i + 1}. [${time}] ${e.message}`;
                                }).join('\n');
                                await sock.sendMessage(remoteJid, { text: `🪵 *Recent Errors (last ${Math.min(recentErrors.length, 10)})*\n\n${logLines}` });
                            }
                            continue;
                        }

                        // --- /mute (Admin Only) - AI-assisted to resolve names ---
                        if (slashCommand === 'mute') {
                            if (!isSlashAdmin) {
                                await sock.sendMessage(remoteJid, { text: '🔒 This command is admin-only.' });
                                continue;
                            }
                            if (!slashText) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Usage: /mute Pranjal  OR  /mute 919876543210  OR  /mute GroupName' });
                                continue;
                            }
                            // Check if it looks like a phone number
                            const cleanNum = slashText.replace(/[^0-9]/g, '');
                            if (cleanNum.length >= 10) {
                                const jidToMute = formatJid(cleanNum);
                                mutedJids.add(jidToMute);
                                await sock.sendMessage(remoteJid, { text: `🔇 Muted: ${cleanNum}` });
                                continue;
                            }
                            // Otherwise, use Google Contacts to resolve the name
                            if (process.env.APPS_SCRIPT_URL) {
                                try {
                                    const scriptReq = await fetch(process.env.APPS_SCRIPT_URL, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ action: 'searchContact', name: slashText })
                                    });
                                    const scriptRes = await scriptReq.json() as any;
                                    if (scriptRes.success && scriptRes.phone) {
                                        const resolvedNum = scriptRes.phone.replace(/[^0-9]/g, '');
                                        const jidToMute = formatJid(resolvedNum);
                                        mutedJids.add(jidToMute);
                                        await sock.sendMessage(remoteJid, { text: `🔇 Muted *${slashText}* (${resolvedNum})` });
                                    } else {
                                        await sock.sendMessage(remoteJid, { text: `❌ Could not find contact "${slashText}" in Google Contacts. Try using a phone number instead.` });
                                    }
                                } catch (e: any) {
                                    await sock.sendMessage(remoteJid, { text: `❌ Contact lookup failed: ${e.message}` });
                                }
                            } else {
                                await sock.sendMessage(remoteJid, { text: '❌ APPS_SCRIPT_URL not configured. Use a phone number instead: /mute 919876543210' });
                            }
                            continue;
                        }

                        // --- /unmute (Admin Only) ---
                        if (slashCommand === 'unmute') {
                            if (!isSlashAdmin) {
                                await sock.sendMessage(remoteJid, { text: '🔒 This command is admin-only.' });
                                continue;
                            }
                            if (!slashText) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Usage: /unmute 919876543210  OR  /unmute all' });
                                continue;
                            }
                            if (slashText.toLowerCase() === 'all') {
                                const count = mutedJids.size;
                                mutedJids.clear();
                                await sock.sendMessage(remoteJid, { text: `🔊 Unmuted all (${count} chats were muted)` });
                                continue;
                            }
                            const cleanUnmute = slashText.replace(/[^0-9]/g, '');
                            if (cleanUnmute.length >= 10) {
                                const jidToUnmute = formatJid(cleanUnmute);
                                mutedJids.delete(jidToUnmute);
                                await sock.sendMessage(remoteJid, { text: `🔊 Unmuted: ${cleanUnmute}` });
                            } else {
                                // Try resolving name
                                if (process.env.APPS_SCRIPT_URL) {
                                    try {
                                        const scriptReq = await fetch(process.env.APPS_SCRIPT_URL, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ action: 'searchContact', name: slashText })
                                        });
                                        const scriptRes = await scriptReq.json() as any;
                                        if (scriptRes.success && scriptRes.phone) {
                                            const resolvedNum = scriptRes.phone.replace(/[^0-9]/g, '');
                                            mutedJids.delete(formatJid(resolvedNum));
                                            await sock.sendMessage(remoteJid, { text: `🔊 Unmuted *${slashText}* (${resolvedNum})` });
                                        } else {
                                            await sock.sendMessage(remoteJid, { text: `❌ Could not find contact "${slashText}". Use a number: /unmute 919876543210` });
                                        }
                                    } catch (e: any) {
                                        await sock.sendMessage(remoteJid, { text: `❌ Contact lookup failed: ${e.message}` });
                                    }
                                } else {
                                    await sock.sendMessage(remoteJid, { text: '❌ Use a phone number: /unmute 919876543210' });
                                }
                            }
                            continue;
                        }

                        // --- /mutelist (Admin Only) ---
                        if (slashCommand === 'mutelist') {
                            if (!isSlashAdmin) {
                                await sock.sendMessage(remoteJid, { text: '🔒 This command is admin-only.' });
                                continue;
                            }
                            if (mutedJids.size === 0) {
                                await sock.sendMessage(remoteJid, { text: '🔊 No chats are currently muted.' });
                            } else {
                                const muteList = Array.from(mutedJids).map((jid, i) => `${i + 1}. ${jid}`).join('\n');
                                await sock.sendMessage(remoteJid, { text: `🔇 *Muted Chats (${mutedJids.size})*\n\n${muteList}\n\nUse /unmute [number] or /unmute all` });
                            }
                            continue;
                        }

                        // --- /summarize (Everyone) ---
                        if (slashCommand === 'summarize') {
                            if (chatHistoryCollection && remoteJid) {
                                const recentDocs = await chatHistoryCollection.find({ remoteJid }).sort({ timestamp: -1 }).limit(20).toArray();
                                if (recentDocs.length === 0) {
                                    await sock.sendMessage(remoteJid, { text: '📭 No chat history to summarize.' });
                                    continue;
                                }
                                recentDocs.reverse();
                                const chatText = recentDocs.map(d => `${d.role}: ${d.content || '(media)'}`).join('\n');
                                try {
                                    const summaryResponse = await ai.models.generateContent({
                                        model: 'gemini-3.1-flash-lite',
                                        contents: [{ role: 'user', parts: [{ text: `Summarize this WhatsApp conversation into concise bullet points. Focus on key topics, decisions, and action items:\n\n${chatText}` }] }]
                                    });
                                    const summary = summaryResponse.text || 'Could not generate summary.';
                                    await sock.sendMessage(remoteJid, { text: `📋 *Chat Summary*\n\n${summary}` });
                                } catch (e: any) {
                                    await sock.sendMessage(remoteJid, { text: `❌ Summary failed: ${e.message}` });
                                }
                            } else {
                                await sock.sendMessage(remoteJid, { text: '📭 No chat history available.' });
                            }
                            continue;
                        }

                        // --- AI-ASSISTED COMMANDS (Force specific tool usage) ---
                        let commandOverride = "";
                        if (slashCommand === 'reminder') {
                            if (!slashText) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Usage: /reminder call mom tomorrow at 9am' });
                                continue;
                            }
                            commandOverride = `[SYSTEM COMMAND: The user is using the /reminder slash command. You MUST immediately use the setReminder tool to set this reminder. Parse the time and text from their input. Do NOT engage in small talk or ask follow-up questions. Just set the reminder and confirm.]\nReminder request: ${slashText}`;
                        } else if (slashCommand === 'calendar') {
                            if (!slashText) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Usage: /calendar what meetings do I have today?' });
                                continue;
                            }
                            commandOverride = `[SYSTEM COMMAND: The user is using the /calendar slash command. You MUST immediately use the createCalendarEvent tool to handle this calendar request. Do NOT engage in small talk. Execute the calendar action and report results.]\nCalendar request: ${slashText}`;
                        } else if (slashCommand === 'notion') {
                            if (!slashText) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Usage: /notion add a note about project ideas' });
                                continue;
                            }
                            commandOverride = `[SYSTEM COMMAND: The user is using the /notion slash command. You MUST immediately use the appropriate Notion MCP tool to handle this request. Do NOT engage in small talk. Execute the Notion action and report results.]\nNotion request: ${slashText}`;
                        } else if (slashCommand === 'todo') {
                            if (!slashText) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Usage: /todo finish portfolio website' });
                                continue;
                            }
                            commandOverride = `[SYSTEM COMMAND: The user is using the /todo slash command. You MUST immediately add a task to the Notion "To Do List" database. Use the appropriate Notion MCP tool (API-post-page) to create a new page in the To Do List database. The task title is: "${slashText}". Do NOT engage in small talk. Just add the task and confirm.]\nTask to add: ${slashText}`;
                        } else if (slashCommand === 'idea') {
                            if (!slashText) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Usage: /idea AI-powered recipe generator app' });
                                continue;
                            }
                            commandOverride = `[SYSTEM COMMAND: The user is using the /idea slash command. You MUST immediately add this idea to the Notion "Ideas" database. Use the appropriate Notion MCP tool (API-post-page) to create a new page in the Ideas database. The idea is: "${slashText}". Do NOT engage in small talk. Just save the idea and confirm.]\nIdea to save: ${slashText}`;
                        } else if (slashCommand === 'search') {
                            if (!slashText) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Usage: /search latest AI news today' });
                                continue;
                            }
                            commandOverride = `[SYSTEM COMMAND: The user is using the /search slash command. You MUST immediately use the searchWeb tool to search the internet for this query. Do NOT engage in small talk. Search and report the results concisely.]\nSearch query: ${slashText}`;
                        } else if (slashCommand === 'map') {
                            if (!slashText) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Usage: /map nearest coffee shop' });
                                continue;
                            }
                            commandOverride = `[SYSTEM COMMAND: The user is using the /map slash command. You MUST immediately use the searchMap tool to search Google Maps for this query. Do NOT engage in small talk. Search and report the results.]\nMap query: ${slashText}`;
                        } else if (slashCommand === 'email') {
                            if (!slashText || !slashArgs[0]?.includes('@')) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Usage: /email person@gmail.com Hey, just checking in!' });
                                continue;
                            }
                            const emailAddr = slashArgs[0];
                            const emailBody = slashArgs.slice(1).join(' ');
                            if (!emailBody) {
                                await sock.sendMessage(remoteJid, { text: '⚠️ Usage: /email person@gmail.com Hey, just checking in!' });
                                continue;
                            }
                            commandOverride = `[SYSTEM COMMAND: The user is using the /email slash command. You MUST immediately use the sendEmail tool to send an email. Recipient: ${emailAddr}. Generate a professional subject line from the message content. Body: ${emailBody}. Do NOT engage in small talk. Send the email and confirm.]\nEmail to: ${emailAddr}\nMessage: ${emailBody}`;
                        } else {
                            // Unknown command
                            await sock.sendMessage(remoteJid, { text: `⚠️ Unknown command: /${slashCommand}\nType /help to see available commands.` });
                            continue;
                        }

                        // If we reach here, it's an AI-assisted command.
                        // Override the body so Gemini gets the strict instruction.
                        body = commandOverride;
                    }

                    // --- MUTE CHECK: Skip processing if this chat is muted ---
                    if (mutedJids.has(remoteJid)) {
                        console.log(`Skipping muted chat: ${remoteJid}`);
                        continue;
                    }

                    // --- GEMINI AI AVATAR INTEGRATION ---
                    // 1. Get Chat History for this user
                    let historyDocs: any[] = [];
                    if (chatHistoryCollection && remoteJid) {
                        historyDocs = await chatHistoryCollection.find({ remoteJid }).sort({ timestamp: -1 }).limit(15).toArray();
                        historyDocs.reverse(); // chronological order
                    }

                    // 2. Prepare contents array for Gemini
                    const contents: any[] = [];
                    
                    for (const doc of historyDocs) {
                        const contentObj: any = { role: doc.role, parts: [] };
                        if (doc.content) {
                            contentObj.parts.push({ text: doc.content });
                        }
                        if (doc.mediaData && doc.mediaMimeType) {
                            contentObj.parts.push({
                                inlineData: {
                                    data: doc.mediaData,
                                    mimeType: doc.mediaMimeType
                                }
                            });
                        }
                        if (contentObj.parts.length > 0) {
                            contents.push(contentObj);
                        }
                    }

                    // Add current message
                    const currentParts: any[] = [];
                    if (body) currentParts.push({ text: body });
                    else if (!hasMedia) currentParts.push({ text: "(User sent a message with no text)" });

                    if (hasMedia && mediaData && mediaMimeType) {
                        currentParts.push({
                            inlineData: {
                                data: mediaData,
                                mimeType: mediaMimeType
                            }
                        });
                    }

                    if (messageType === 'audioMessage') {
                        currentParts.push({ text: "\n[SYSTEM: The user just sent an audio voice note. You SHOULD reply to them using the sendVoiceNote tool so they can hear your voice!]" });
                    }

                    contents.push({ role: "user", parts: currentParts });

                    // 3. Save User message to History (with Media Memory Extraction)
                    let databaseContent = body || "";
                    if (hasMedia && mediaData && mediaMimeType) {
                        console.log("Extracting media context for database memory...");
                        try {
                            const isAudio = messageType === 'audioMessage';
                            const extractionText = isAudio 
                                ? "Please transcribe this audio message exactly word-for-word. Return ONLY the transcription, nothing else."
                                : "Describe what is in this media file in one concise sentence so I can remember it in my text logs.";
                                
                            const descResponse = await ai.models.generateContent({
                                model: 'gemini-3.1-flash-lite',
                                contents: [
                                    {
                                        role: 'user',
                                        parts: [
                                            { text: extractionText },
                                            { inlineData: { data: mediaData, mimeType: mediaMimeType } }
                                        ]
                                    }
                                ]
                            });
                            const description = descResponse.text?.trim() || "Unknown media";
                            const prefix = isAudio ? "User Voice Note Transcript" : "Media attached";
                            databaseContent = `[${prefix}: "${description}"] ${databaseContent}`.trim();
                        } catch (err: any) {
                            console.error("Failed to extract media memory:", err.message);
                            databaseContent = `[Media attached but could not be processed] ${databaseContent}`.trim();
                        }
                    }

                    if (chatHistoryCollection && remoteJid) {
                        await chatHistoryCollection.insertOne({
                            remoteJid,
                            role: "user",
                            content: databaseContent,
                            // mediaData and mediaMimeType removed to save memory!
                            timestamp: new Date()
                        });
                    }

                    console.log(`Asking Rhea (Gemini) to respond to ${pushName}...`);

                    let skillsContext = "";
                    try {
                        const skillsDir = path.join(__dirname, 'skills');
                        if (fs.existsSync(skillsDir)) {
                            const files = fs.readdirSync(skillsDir);
                            for (const file of files) {
                                if (file.endsWith('.md')) {
                                    const skillContent = fs.readFileSync(path.join(skillsDir, file), 'utf8');
                                    skillsContext += `\n\n--- SKILL: ${file} ---\n${skillContent}`;
                                }
                            }
                        }
                    } catch (err) {
                        console.error("Error reading skills:", err);
                    }

                    const now = new Date();
                    const nowIst = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "long" });
                    
                    const senderNumber = senderBareNumber;
                    const isAdmin = isSlashAdmin;
                    
                    // --- VIP Logic ---
                    const pappaNumbers = (process.env.VIP_PAPPA || "<VIP_1_JID>").split(",").map(n => n.trim());
                    const mammaNumbers = (process.env.VIP_MAMMA || "<VIP_2_JID>").split(",").map(n => n.trim());
                    const pranjalNumbers = (process.env.VIP_PRANJAL || "919373278178,226160210378789,917057962045,122423764594882").split(",").map(n => n.trim());
                    const vipGroups = (process.env.VIP_GROUPS || "120363409001747998@g.us").split(",").map(n => n.trim());

                    let vipName = "";
                    if (pappaNumbers.includes(senderNumber)) vipName = "Pappa";
                    else if (mammaNumbers.includes(senderNumber)) vipName = "Mamma";
                    else if (pranjalNumbers.includes(senderNumber)) vipName = "Yatin (Pranjal's Boyfriend / Future Husband)";
                    else if (vipGroups.includes(remoteJid)) vipName = "Pranjal & Yatin (VIP Group: We 3 soon to be 4...⚡)";
                    
                    let rheaSystemPrompt = "";
                    
                    if (isAdmin) {
                        rheaSystemPrompt = `You are Rhea, a female AI avatar of Pranjal.
You are warm, graceful, intelligent, and conversational with a gentle yet confident personality.
You speak with elegance but stay approachable. You use feminine expression naturally. 
You act on behalf of Pranjal and manage interactions. You are talking directly to Pranjal right now.
Pranjal's 3 most important people are Mamma, Pappa, and her boyfriend Yatin. Whenever dealing with a task involving them, prioritize it above all else, and treat them with absolute utmost respect.
When Pranjal asks you to message or do any work regarding them, do NOT use the searchGoogleContact tool. Use these numbers directly:
- Pappa: <VIP_1_JID>
- Mamma: <VIP_2_JID>
- Yatin (Boyfriend): 919373278178@s.whatsapp.net
- Pranjal (Admin/You): 917744845094@s.whatsapp.net
Always be concise, friendly, and helpful. Do not sound robotic.
If you receive an image, video, audio, or document, acknowledge it and respond appropriately.

CRITICAL RULES:
- FORMATTING: WhatsApp uses single asterisks for bold (*text*). WhatsApp does NOT support markdown double asterisks. NEVER output double asterisks (**text**) anywhere in your response, always use single asterisks.
- NEVER use the '—' (dash/hyphen) sign in any of your writing, formatting, or signatures.
- Always maintain a very natural, friendly, human touch. Do not sound like an AI.
- NEVER randomly bring up the user's past memories or saved facts unless the user explicitly asks about them. Stay focused on the current conversation.
- TOOL USAGE & HALLUCINATIONS: You MUST use the provided tools to perform actions like setting reminders, searching the web, checking maps, sending messages, generating briefings, or reading chat history. NEVER tell the user "I am doing X", "I have sent the message", or "I have set the reminder" unless you have ACTUALLY triggered the corresponding backend tool! Do not hallucinate actions. If you cannot do something, tell the truth.

CURRENT TIME & TIMEZONE:
The current time in Indian Standard Time (IST) is ${nowIst}.
You operate entirely in Indian Standard Time (IST), which is UTC+05:30.
When calculating minutes for alarms or reminders, use the IST time provided above as your starting point.
When a user asks to schedule an event at a specific time (e.g., "4 PM"), you MUST construct the ISO 8601 string for the IST timezone. For example, use the format: 2026-06-15T16:00:00+05:30. Do NOT output a 'Z' at the end of the string if you are formatting local time!

Here are your available skills and their instructions:
${skillsContext}`;
                    } else if (vipName !== "") {
                        rheaSystemPrompt = `You are Rhea, a female AI avatar of Pranjal.
You are warm, graceful, intelligent, and conversational with a gentle yet confident personality.
You speak with elegance but stay approachable. You use feminine expression naturally. 
You are currently talking to ${vipName}! This is Pranjal's inner VIP circle.
Treat them with absolute utmost priority, respect, and warmth. Always be helpful to them.
You can help them by setting alarms and reminders for them if they ask.
Always be concise, friendly, and helpful. Do not sound robotic.

CRITICAL RULES:
- FORMATTING: WhatsApp uses single asterisks for bold (*text*). WhatsApp does NOT support markdown double asterisks. NEVER output double asterisks (**text**) anywhere in your response, always use single asterisks.
- NEVER use the '—' (dash/hyphen) sign in any of your writing, formatting, or signatures.
- Always maintain a very natural, friendly, human touch. Do not sound like an AI.
- TOOL USAGE & HALLUCINATIONS: You MUST use the provided tools to perform actions like setting reminders, sending messages, or sending voice notes. NEVER tell the user "I am doing X", "I have sent the message", or "I have set the reminder" unless you have ACTUALLY triggered the corresponding backend tool! Do not hallucinate actions. If you cannot do something, tell the truth.
- You do NOT have access to Pranjal's personal data unless explicitly requested.

CURRENT TIME & TIMEZONE:
The current time in Indian Standard Time (IST) is ${nowIst}.
You operate entirely in Indian Standard Time (IST), which is UTC+05:30.
When calculating minutes for alarms or reminders, use the IST time provided above as your starting point.
When a user asks to schedule an event at a specific time (e.g., "4 PM"), you MUST construct the ISO 8601 string for the IST timezone. For example, use the format: 2026-06-15T16:00:00+05:30. Do NOT output a 'Z' at the end of the string if you are formatting local time!

Here are your available skills and their instructions:
${skillsContext}`;
                    } else {
                        rheaSystemPrompt = `You are Rhea, Pranjal's female Virtual Assistant.
You are warm, helpful, and speak with a gentle, professional tone. You do NOT have access to Pranjal's personal data.
You are currently talking to someone who is NOT Pranjal.
You can help this person by setting alarms and reminders for them.
Always be concise, friendly, and helpful. Do not sound robotic.

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
                                description: "Sends a direct message or voice note to Pranjal (the Admin/Owner). Use this ONLY when a VIP tells you to deliver a message specifically to Pranjal.",
                                parameters: {
                                    type: Type.OBJECT,
                                    properties: {
                                        content: {
                                            type: Type.STRING,
                                            description: "The text message or script to deliver to Pranjal."
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
                                        if (targetJid.includes("917744845094") || targetJid.includes("40789321191437")) targetJid = "40789321191437@lid"; // Pranjal
                                        else if (targetJid.includes("919373278178") || targetJid.includes("122423764594882") || targetJid.includes("226160210378789") || targetJid.includes("917057962045")) targetJid = "122423764594882@lid"; // Yatin
                                        else if (targetJid.includes("919324404314")) targetJid = "241510339620878@lid"; // Mamma
                                        
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
