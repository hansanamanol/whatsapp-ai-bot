const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { google } = require('googleapis');

ffmpeg.setFfmpegPath(ffmpegPath);

// 👑 ADMIN / BATCH REP IDENTIFICATION
const ADMIN_PHONE_NUMBER = "94762513957";
const ADMIN_LID = "17848192627279";
const ADMIN_JIDS = ["178481912627279@lid"];

// ======================================================================
// 📚 CUSTOM KNOWLEDGE BASE
// ======================================================================
const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge.json');
let knowledgeBase = [];

try {
    if (fs.existsSync(KNOWLEDGE_FILE)) {
        knowledgeBase = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
    }
} catch (err) {
    console.error('Error loading knowledge.json:', err);
    knowledgeBase = [];
}

function saveKnowledgeBase() {
    try {
        fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledgeBase, null, 2));
    } catch (err) {
        console.error('Error saving knowledge.json:', err);
    }
}

function buildPromptWithKnowledge(basePrompt) {
    if (knowledgeBase.length === 0) return basePrompt;
    const knowledgeText = knowledgeBase.map((k, i) => `${i + 1}. ${k}`).join('\n');
    return `${basePrompt}\n\n[BATCH-SPECIFIC KNOWLEDGE — Batch Rep (Monal) saved this info. If it's relevant to the user's question, prioritize using it over general knowledge:]\n${knowledgeText}`;
}

// ======================================================================
// 📁 FILE REGISTRY
// ======================================================================
const FILES_DIR = path.join(__dirname, 'resources');
if (!fs.existsSync(FILES_DIR)) {
    fs.mkdirSync(FILES_DIR, { recursive: true });
}

const FILE_REGISTRY_PATH = path.join(__dirname, 'files-registry.json');
let fileRegistry = [];

try {
    if (fs.existsSync(FILE_REGISTRY_PATH)) {
        fileRegistry = JSON.parse(fs.readFileSync(FILE_REGISTRY_PATH, 'utf8'));
    }
} catch (err) {
    console.error('Error loading files-registry.json:', err);
    fileRegistry = [];
}

function saveFileRegistry() {
    try {
        fs.writeFileSync(FILE_REGISTRY_PATH, JSON.stringify(fileRegistry, null, 2));
    } catch (err) {
        console.error('Error saving files-registry.json:', err);
    }
}

// ======================================================================
// 🔄 SWAP SYSTEM
// ======================================================================
const SWAP_REQUESTS_FILE = path.join(__dirname, 'swap-requests.json');
let swapRequests = {};

try {
    if (fs.existsSync(SWAP_REQUESTS_FILE)) {
        swapRequests = JSON.parse(fs.readFileSync(SWAP_REQUESTS_FILE, 'utf8'));
    }
} catch (err) {
    console.error('Error loading swap-requests.json:', err);
    swapRequests = {};
}

function saveSwapRequests() {
    try {
        fs.writeFileSync(SWAP_REQUESTS_FILE, JSON.stringify(swapRequests, null, 2));
    } catch (err) {
        console.error('Error saving swap-requests.json:', err);
    }
}

function normalizeGroupLabel(raw) {
    return raw.toLowerCase().replace(/group|grp|lab/gi, '').trim();
}

function extractPhoneDisplay(jid) {
    const normalized = jidNormalizedUser(jid) || jid;
    if (normalized.endsWith('@s.whatsapp.net')) {
        const match = normalized.match(/^(\d+)@/);
        return match ? `+${match[1]}` : normalized;
    }
    return null;
}

// ======================================================================
// 🔒 ADMIN CHECK
// ======================================================================
function isSenderAdmin(sender) {
    const normalized = jidNormalizedUser(sender) || sender;
    if (ADMIN_JIDS.includes(sender) || ADMIN_JIDS.includes(normalized)) return true;
    const isPhoneMatch = normalized === `${ADMIN_PHONE_NUMBER}@s.whatsapp.net`;
    const isLidMatch = ADMIN_LID && (normalized === `${ADMIN_LID}@lid` || sender.includes(ADMIN_LID));
    return isPhoneMatch || isLidMatch || sender.includes(ADMIN_PHONE_NUMBER);
}

// ======================================================================
// 🧵 CONCURRENCY QUEUE
// ======================================================================
const MAX_CONCURRENT = 3;

class ConcurrencyQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }
    add(task, onQueued) {
        return new Promise((resolve, reject) => {
            const willWait = this.running >= this.concurrency;
            this.queue.push({ task, resolve, reject });
            if (willWait && typeof onQueued === 'function') {
                onQueued(this.queue.length);
            }
            this._next();
        });
    }
    _next() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;
        const { task, resolve, reject } = this.queue.shift();
        this.running++;
        task().then(resolve).catch(reject).finally(() => {
            this.running--;
            this._next();
        });
    }
}

const messageQueue = new ConcurrencyQueue(MAX_CONCURRENT);

// ======================================================================
// 🔁 MESSAGE DEDUP
// ======================================================================
const processedMessages = new Set();
const MAX_TRACKED_MESSAGES = 1000;

function markProcessed(id) {
    processedMessages.add(id);
    if (processedMessages.size > MAX_TRACKED_MESSAGES) {
        const oldest = processedMessages.values().next().value;
        processedMessages.delete(oldest);
    }
}

// ======================================================================
// 📅 GOOGLE CALENDAR API SETUP
// ======================================================================
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.warn('⚠️ Google Calendar env vars set karala na — calendar commands wada karanne na.');
}

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
);

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = google.calendar({
    version: 'v3',
    auth: oauth2Client
});

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

async function getTodaysEvents() {
    try {
        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);

        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: startOfDay.toISOString(),
            timeMax: endOfDay.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 20
        });

        return response.data.items || [];
    } catch (error) {
        console.error("Error fetching today's events:", error.message);
        return [];
    }
}

async function getNextEvent() {
    try {
        const now = new Date().toISOString();
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: now,
            maxResults: 1,
            singleEvents: true,
            orderBy: 'startTime'
        });
        return response.data.items && response.data.items.length > 0 ? response.data.items[0] : null;
    } catch (error) {
        console.error('Error fetching next event:', error.message);
        return null;
    }
}

async function getEventsForDate(dateStr) {
    try {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return null;

        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: startOfDay.toISOString(),
            timeMax: endOfDay.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 20
        });
        return response.data.items || [];
    } catch (error) {
        console.error('Error fetching events for date:', error.message);
        return null;
    }
}

function formatEventTime(dateTimeStr) {
    if (!dateTimeStr) return 'All day';
    const date = new Date(dateTimeStr);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDateDisplay(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

// ======================================================================
// 🚀 EXPRESS WEB SERVER
// ======================================================================
const app = express();
const PORT = process.env.PORT || 3000;
let latestQR = "";
let isConnected = false;

app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <html>
                <head><title>HansanaBot — Connected</title>
                <meta http-equiv="refresh" content="30">
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
                    <h2 style="color:#2ea043;">✅ Bot එක Connected & Running!</h2>
                    <p style="color:#58a6ff;">WhatsApp Bot එක සාර්ථකව Connect වෙලා!</p>
                    <p style="color:#8b949e;">ඔබට Bot එකට DM කරලා Test කරන්න පුළුවන්.</p>
                    <p style="color:#8b949e;font-size:12px;margin-top:30px;">Page එක තත්පර 30කට වතාවක් Auto Refresh වෙයි</p>
                </body>
            </html>
        `);
    }
    if (!latestQR) {
        return res.send(`
            <html>
                <head><meta http-equiv="refresh" content="3"></head>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
                    <h2 style="color:#f0883e;">⏳ QR Code එක Loading...</h2>
                    <p style="color:#8b949e;">තත්පර 3න් Auto Refresh වෙයි</p>
                    <p style="color:#8b949e;font-size:14px;">Bot එක WhatsApp එකට Connect වෙමින්...</p>
                </body>
            </html>
        `);
    }
    try {
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`
            <html>
                <head><title>WhatsApp Bot QR Code</title>
                <meta http-equiv="refresh" content="15">
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
                    <h2 style="color:#58a6ff;">📱 Scan this QR Code with WhatsApp</h2>
                    <img src="${qrImage}" style="border:10px solid white;border-radius:10px;width:300px;height:300px;"/>
                    <p style="color:#8b949e;margin-top:20px;">QR Code එක Scan කරලා Bot එක Connect කරන්න</p>
                    <p style="color:#8b949e;font-size:14px;">Page එක තත්පර 15කට වතාවක් Auto Refresh වෙයි</p>
                </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR code');
    }
});

app.listen(PORT, () => {
    console.log(`✅ Web server running on port ${PORT}`);
});

// ======================================================================
// 🤖 GEMINI API SETUP
// ======================================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY not set. Exiting.');
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const systemInstruction = `
You are HansanaBot, an intelligent Gemini AI assistant working for the SLIIT IT Batch Representative (Monal Hansana).

YOUR IDENTITY & RESPONSIBILITIES:
- Your Name: HansanaBot
- You assist the Batch Rep, Monal (Hansana), by helping SLIIT students with their academic queries.
- Answer student questions naturally in Singlish, Sinhala, or English based on the user's language.
- Assist students with Timetable info, Calendar link, Issue forms, LMS links, Course Outlines, and LIC contacts.
- Read images, voice notes, and PDFs provided by users accurately and explain them.

BATCH REPRESENTATIVE (MONAL HANSANA) CONTACT DETAILS:
- When students ask for Batch Rep's contact details, provide cleanly:
  * Name: Monal Hansana (SLIIT IT Batch Representative)
  * Contact Number: +94 76 251 3957 (076 251 3957)
  * Official SLIIT Email: it26100930@my.sliit.lk

Y1S2 MODULE DETAILS & LIC INFORMATION:
1. IT1170 - Data Structures and Algorithms (DSA) - LIC: Prof. Nathali Silva (nathali.s@sliit.lk)
2. IT1160 - Discrete Mathematics - LIC: Ms. Nipuni Maleesha (nipuni.m@sliit.lk)
3. SE1020 - Object Oriented Programming (OOP) - LIC: Ms. Thilini Jayalath (thilini.j@sliit.lk)
4. IT1150 - Technical Writing - LIC: Ms. Dinushika Jayathissa (dinushika.j@sliit.lk)
5. IE1011 - Information Systems - LIC: Ms. Chathurangika Kahandawarachchi (chathurangika.k@sliit.lk)

ACADEMIC & UNIVERSITY RULES:
- Attendance: Minimum 80% attendance is strictly required for labs and lectures.
- Assessments: Continuous Assessments + Final Exam.
- Lab Group Switching: Requires prior LIC approval or valid medical reason.

IMPORTANT LINKS & PORTALS:
1. Timetable / Calendar: https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t
2. Courseweb (LMS): https://courseweb.sliit.lk/
3. Eduscope (Lecture Recordings): https://eduscope.sliit.lk/
4. Issue Reporting Form: https://docs.google.com/forms/d/e/1FAIpQLSfOUJnkMp8Tdig0C187WDOgU5AZmtPh3ayBZ-_z9xd23K3Zgw/viewform?usp=publish-editor
5. SLIIT Support Desk: https://ask.sliit.lk/

CRITICAL — NEVER CLAIM TO HAVE SENT/POSTED SOMETHING:
- You CANNOT actually send messages, post announcements, or perform any action outside this chat reply.
- NEVER say things like "I've sent this to the group" or "yawanawa" / "දැම්මා" as if the action already happened.

CRITICAL — NO LATEX, USE UNICODE MATH SYMBOLS DIRECTLY:
- WhatsApp text messages CANNOT render LaTeX. NEVER write $\\cup$, \\cap, \\in, $$...$$, \\( \\), or \\frac{a}{b}.
- Always use Unicode symbols directly: ∪, ∩, ∈, ∉, ⊂, ⊆, ⊃, ⊇, ∅, ∀, ∃, ≤, ≥, ≠, ≈, ×, ÷, ±, √, π, ∞, →, ⇒, ⇔, Σ, ∫.
- For fractions, write "a/b" or "a ÷ b".
`;

// Safety net: Gemini's system instruction tells it to avoid LaTeX, but if it
// slips into LaTeX anyway, this converts common math commands to Unicode
// symbols before the reply reaches WhatsApp.
function formatMathForWhatsApp(text) {
    if (!text) return text;
    const replacements = [
        [/\\cup/g, '∪'], [/\\cap/g, '∩'], [/\\in\b/g, '∈'], [/\\notin\b/g, '∉'],
        [/\\subseteq/g, '⊆'], [/\\subset/g, '⊂'], [/\\supseteq/g, '⊇'], [/\\supset/g, '⊃'],
        [/\\emptyset/g, '∅'], [/\\varnothing/g, '∅'], [/\\forall/g, '∀'], [/\\exists/g, '∃'],
        [/\\leq/g, '≤'], [/\\geq/g, '≥'], [/\\neq/g, '≠'], [/\\approx/g, '≈'],
        [/\\times/g, '×'], [/\\div/g, '÷'], [/\\pm/g, '±'], [/\\sqrt/g, '√'],
        [/\\infty/g, '∞'], [/\\rightarrow/g, '→'], [/\\to\b/g, '→'],
        [/\\Rightarrow/g, '⇒'], [/\\Leftrightarrow/g, '⇔'], [/\\sum/g, 'Σ'], [/\\int/g, '∫'],
        [/\\pi\b/g, 'π'], [/\\theta\b/g, 'θ'], [/\\alpha\b/g, 'α'], [/\\beta\b/g, 'β'],
        [/\\frac\{([^}]*)\}\{([^}]*)\}/g, '$1/$2'],
        [/\$\$?/g, ''], [/\\\(/g, ''], [/\\\)/g, ''], [/\\\[/g, ''], [/\\\]/g, '']
    ];
    let result = text;
    for (const [pattern, symbol] of replacements) {
        result = result.replace(pattern, symbol);
    }
    return result;
}

const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash-lite",
    systemInstruction: systemInstruction
});

// ======================================================================
// 🎵 AUDIO CONVERSION
// ======================================================================
function convertAudioToWav(inputBuffer) {
    return new Promise((resolve, reject) => {
        const uniqueId = crypto.randomUUID();
        const tempIn = path.join(__dirname, `temp_${uniqueId}.ogg`);
        const tempOut = path.join(__dirname, `temp_${uniqueId}.mp3`);
        fs.writeFileSync(tempIn, inputBuffer);
        ffmpeg(tempIn)
            .toFormat('mp3')
            .on('end', () => {
                try {
                    const outputBuffer = fs.readFileSync(tempOut);
                    if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                    if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
                    resolve(outputBuffer);
                } catch (e) { reject(e); }
            })
            .on('error', (err) => {
                if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
                reject(err);
            })
            .save(tempOut);
    });
}

// ======================================================================
// 💬 MAIN MESSAGE PROCESSING
// ======================================================================
async function connectToWhatsApp() {
    try {
        console.log('🔄 Loading auth state...');
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        console.log('📂 Auth state loaded. Creating WhatsApp socket...');

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            badSessionDeleteHistory: true,
            retryRequestDelayMs: 2000,
            // "init queries" (blocklist/privacy settings) — bot ekata use wenne
            // nathi nisa, ema queries ma fire wenna epa kiyala off karanawa —
            // mekenma "unexpected error in 'init queries'" timeout eka ain wenawa.
            fireInitQueries: false,
            defaultQueryTimeoutMs: 60000
        });
        console.log('🔌 Socket created, waiting for connection.update events...');

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                latestQR = qr;
                isConnected = false;
                console.log('📱 QR Code generated!');
                qrcodeTerminal.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isConnected = false;
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                // Reconnect welawe, mek dead socket ekata connect wela hitiya
                // listeners tika explicitly ain karanawa — memory leak wenna
                // idata dena listeners tika accumulate wena eka nawaththanna.
                sock.ev.removeAllListeners();
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting in 3s...');
                    setTimeout(() => {
                        connectToWhatsApp().catch((err) => {
                            console.error('❌ Reconnect attempt failed:', err);
                        });
                    }, 3000);
                } else {
                    console.log('Logged out. Restarting...');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                latestQR = "";
                isConnected = true;
                console.log('✅ WhatsApp AI Bot is Ready and Online!');
            }
        });

        async function processMessage(sock, msg) {
            console.log('📩 [DEBUG] processMessage START');

            const sender = msg.key.remoteJid;
            const isGroup = sender.endsWith('@g.us');
            console.log('📩 [DEBUG] Sender:', sender);
            console.log('📩 [DEBUG] Is Group:', isGroup);

            if (isGroup) {
                console.log('⏭️ [DEBUG] Skipping - Group message');
                return;
            }

            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate('composing', sender);

            const imgMsg = msg.message.imageMessage ||
                           msg.message.viewOnceMessage?.message?.imageMessage ||
                           msg.message.viewOnceMessageV2?.message?.imageMessage ||
                           msg.message.ephemeralMessage?.message?.imageMessage;

            const audioMsg = msg.message.audioMessage ||
                             msg.message.viewOnceMessage?.message?.audioMessage ||
                             msg.message.ephemeralMessage?.message?.audioMessage;

            const docMsg = msg.message.documentMessage ||
                           msg.message.documentWithCaptionMessage?.message?.documentMessage ||
                           msg.message.ephemeralMessage?.message?.documentMessage;

            const firstMsgType = Object.keys(msg.message)[0];
            const contextInfo = msg.message[firstMsgType]?.contextInfo || msg.message.extendedTextMessage?.contextInfo;
            const quotedMsgObj = contextInfo?.quotedMessage;

            const quotedText = quotedMsgObj?.conversation ||
                              quotedMsgObj?.extendedTextMessage?.text ||
                              quotedMsgObj?.imageMessage?.caption || "";

            const rawMessageText = msg.message.conversation ||
                                   msg.message.extendedTextMessage?.text ||
                                   imgMsg?.caption ||
                                   docMsg?.caption || "";

            console.log('📝 [DEBUG] rawMessageText:', rawMessageText);

            let fullUserPrompt = rawMessageText;
            if (quotedText) {
                fullUserPrompt = `[Quoted/Referenced Text: "${quotedText}"]\nUser Action Requested: "${rawMessageText}"`;
                console.log('📝 [DEBUG] fullUserPrompt (with quoted):', fullUserPrompt);
            }

            // ======================================================================
            // AUDIO
            // ======================================================================
            if (audioMsg) {
                console.log('🎵 [DEBUG] Audio message detected');
                try {
                    await sock.sendMessage(sender, { text: "🎙️ **Voice Note Process වෙමින්...**" }, { quoted: msg });
                    const oggBuffer = await downloadMediaMessage(msg, 'buffer', {});
                    const mp3Buffer = await convertAudioToWav(oggBuffer);
                    const base64Audio = mp3Buffer.toString('base64');
                    const audioPart = { inlineData: { data: base64Audio, mimeType: 'audio/mp3' } };
                    const prompt = buildPromptWithKnowledge("Listen carefully to this audio message. Reply clearly.");
                    const result = await model.generateContent([prompt, audioPart]);
                    const reply = formatMathForWhatsApp(result.response.text());
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                    console.log('✅ [DEBUG] Audio reply sent');
                } catch (err) {
                    console.error('Error processing Audio:', err);
                    await sock.sendMessage(sender, { text: "❌ Voice Message එක තේරුම් ගන්න බැරි වුණා." }, { quoted: msg });
                }
                return;
            }

            // ======================================================================
            // PDF - ADD FILE (Admin)
            // ======================================================================
            if (docMsg && /^add file\b/i.test(rawMessageText.toLowerCase().trim())) {
                console.log('📁 [DEBUG] Add file command detected');
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { text: "❌ මචං, File Add කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                const keyword = rawMessageText.replace(/^add file\s*:?\s*/i, '').trim().toLowerCase();
                if (!keyword) {
                    await sock.sendMessage(sender, { text: `⚠️ Keyword එකත් caption එකේ දෙන්න — e.g. "add file: course outline"` }, { quoted: msg });
                    return;
                }
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const ext = path.extname(docMsg.fileName || '') || '.pdf';
                    const storedFileName = `${crypto.randomUUID()}${ext}`;
                    fs.writeFileSync(path.join(FILES_DIR, storedFileName), buffer);

                    fileRegistry.push({
                        keyword,
                        fileName: docMsg.fileName || `${keyword}${ext}`,
                        mimetype: docMsg.mimetype || 'application/pdf',
                        storedFileName
                    });
                    saveFileRegistry();

                    await sock.sendMessage(sender, { text: `✅ File එක save කළා! Keyword: "${keyword}"\n\nදැන් student කෙනෙක් "${keyword}" කියලා type කළොත් file එක automatic ලෙස එවනවා.` }, { quoted: msg });
                    console.log('✅ [DEBUG] File saved successfully');
                } catch (err) {
                    console.error('Error saving file:', err);
                    await sock.sendMessage(sender, { text: "❌ File එක save කිරීමේදී Error එකක් ආවා." }, { quoted: msg });
                }
                return;
            }

            // ======================================================================
            // PDF ANALYSIS
            // ======================================================================
            if (docMsg) {
                console.log('📄 [DEBUG] PDF document detected');
                try {
                    const mimeType = docMsg?.mimetype || '';
                    if (mimeType === 'application/pdf') {
                        await sock.sendMessage(sender, { text: "📄 **PDF Document එක Read කරමින්...**" }, { quoted: msg });
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const base64Pdf = buffer.toString('base64');
                        const pdfPart = { inlineData: { data: base64Pdf, mimeType: 'application/pdf' } };
                        const captionPrompt = rawMessageText ? ` User instructions: "${rawMessageText}"` : "";
                        const prompt = buildPromptWithKnowledge("Read this PDF document carefully and fulfill the user request." + captionPrompt);
                        const result = await model.generateContent([prompt, pdfPart]);
                        const reply = formatMathForWhatsApp(result.response.text());
                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                        console.log('✅ [DEBUG] PDF analysis reply sent');
                    }
                } catch (err) {
                    console.error('Error processing PDF:', err);
                    await sock.sendMessage(sender, { text: "❌ PDF එක Read කරගන්න බැරි වුණා." }, { quoted: msg });
                }
                return;
            }

            // ======================================================================
            // IMAGE
            // ======================================================================
            if (imgMsg) {
                console.log('🖼️ [DEBUG] Image detected');
                try {
                    await sock.sendMessage(sender, { text: "⏳ **Image එක Processing...**" }, { quoted: msg });
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const base64Image = buffer.toString('base64');
                    const mimeType = imgMsg.mimetype || 'image/jpeg';
                    const imagePart = { inlineData: { data: base64Image, mimeType: mimeType } };
                    const captionPrompt = rawMessageText ? ` User instructions: "${rawMessageText}"` : "";
                    const prompt = buildPromptWithKnowledge("Read all details in this screenshot/image. Answer clearly." + captionPrompt);
                    const result = await model.generateContent([prompt, imagePart]);
                    const reply = formatMathForWhatsApp(result.response.text());
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                    console.log('✅ [DEBUG] Image reply sent');
                } catch (err) {
                    console.error('Error processing Image:', err);
                    await sock.sendMessage(sender, { text: "❌ Image එක කියවගන්න බැරි වුණා." }, { quoted: msg });
                }
                return;
            }

            // ======================================================================
            // TEXT MESSAGES
            // ======================================================================
            if (!isGroup) {
                console.log('✅ [DEBUG] Inside !isGroup block');
                const textLower = rawMessageText.toLowerCase().trim();
                console.log('📝 [DEBUG] textLower:', textLower);

                // ---------- WHO AM I ----------
                const isWhoAmIQuestion = /\bwho\s*am\s*i\b/i.test(textLower)
                    || textLower.includes('man kauda') || textLower.includes('mn kauda') || textLower.includes('mama kauda')
                    || rawMessageText.includes('මං කවුද') || rawMessageText.includes('මම කවුද');

                if (isWhoAmIQuestion) {
                    console.log('👤 [DEBUG] Who am I question detected');
                    const isAdmin = isSenderAdmin(sender);
                    if (isAdmin) {
                        await sock.sendMessage(sender, { text: `👋 ඔයා තමයි *Monal Hansana* — SLIIT IT Y1S2 Batch Representative! ✅` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: `👤 ඔයා student කෙනෙක්.` }, { quoted: msg });
                    }
                    console.log('✅ [DEBUG] Who am I reply sent');
                    return;
                }

                // ---------- WHOAMI ----------
                if (textLower === 'whoami' || textLower === 'my id' || textLower === 'myid') {
                    console.log('🆔 [DEBUG] whoami command detected');
                    const normalized = jidNormalizedUser(sender) || sender;
                    await sock.sendMessage(sender, { text: `🆔 *ඔයාගේ WhatsApp ID*\nRaw: \`${sender}\`\nNormalized: \`${normalized}\`` }, { quoted: msg });
                    console.log('✅ [DEBUG] whoami reply sent');
                    return;
                }

                // ---------- TODAY CLASSES ----------
                if (textLower === 'today classes' || textLower === 'today timetable' || textLower === 'today schedule' || textLower === 'today') {
                    console.log('📅 [DEBUG] today command detected');
                    const events = await getTodaysEvents();
                    if (events.length === 0) {
                        await sock.sendMessage(sender, { text: `📅 *Today's Schedule*\n\n🎉 No classes scheduled for today!` }, { quoted: msg });
                    } else {
                        let message = `📅 *Today's Classes - ${formatDateDisplay(new Date().toISOString())}*\n\n`;
                        events.forEach((event, i) => {
                            const time = event.start.dateTime ? formatEventTime(event.start.dateTime) : 'All day';
                            const location = event.location ? `📍 ${event.location}` : '';
                            message += `${i+1}. *${event.summary}*\n   🕐 ${time}\n`;
                            if (location) message += `   ${location}\n`;
                            message += '\n';
                        });
                        await sock.sendMessage(sender, { text: message }, { quoted: msg });
                    }
                    console.log('✅ [DEBUG] today reply sent');
                    return;
                }

                // ---------- NEXT CLASS ----------
                if (textLower === 'next class' || textLower === 'next lecture' || textLower === 'next') {
                    console.log('📅 [DEBUG] next class command detected');
                    const event = await getNextEvent();
                    if (!event) {
                        await sock.sendMessage(sender, { text: `📅 *Next Class*\n\n🎉 No upcoming classes found.` }, { quoted: msg });
                    } else {
                        const startTime = event.start.dateTime ? formatEventTime(event.start.dateTime) : 'All day';
                        const date = event.start.dateTime ? formatDateDisplay(event.start.dateTime) : 'Unknown';
                        const location = event.location ? `📍 ${event.location}` : '';
                        let message = `📅 *Next Class*\n\n📚 *${event.summary}*\n📅 ${date}\n🕐 ${startTime}\n`;
                        if (location) message += `${location}\n`;
                        await sock.sendMessage(sender, { text: message }, { quoted: msg });
                    }
                    console.log('✅ [DEBUG] next class reply sent');
                    return;
                }

                // ---------- CHECK DATE ----------
                const dateMatch = rawMessageText.match(/^check date\s+(\d{4}-\d{2}-\d{2})$/i);
                if (dateMatch) {
                    console.log('📅 [DEBUG] check date command detected');
                    const dateStr = dateMatch[1];
                    const events = await getEventsForDate(dateStr);
                    if (events === null) {
                        await sock.sendMessage(sender, { text: `⚠️ Invalid date format. Use: \`check date YYYY-MM-DD\`` }, { quoted: msg });
                    } else if (events.length === 0) {
                        await sock.sendMessage(sender, { text: `📅 *Schedule for ${formatDateDisplay(dateStr)}*\n\n🎉 No classes on this day!` }, { quoted: msg });
                    } else {
                        let message = `📅 *Schedule for ${formatDateDisplay(dateStr)}*\n\n`;
                        events.forEach((event, i) => {
                            const time = event.start.dateTime ? formatEventTime(event.start.dateTime) : 'All day';
                            message += `${i+1}. *${event.summary}*\n   🕐 ${time}\n\n`;
                        });
                        await sock.sendMessage(sender, { text: message }, { quoted: msg });
                    }
                    console.log('✅ [DEBUG] check date reply sent');
                    return;
                }

                // ---------- CALENDAR LINK ----------
                if (textLower === 'calendar' || textLower === 'timetable' || textLower === 'time table' || textLower === 'time' || textLower === 'calender') {
                    console.log('📅 [DEBUG] calendar link command detected');
                    await sock.sendMessage(sender, {
                        text: `📅 *SLIIT Timetable එක ඔබගේ Phone එකට Add කරගන්න*

🔗 *Link:*
https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t

📌 *ඊළඟ පියවර:*
1. Link එක Open කරලා "Add" / "Subscribe" කරන්න.
2. Google Calendar App එක Open කරලා ☰ Menu එකෙන් "Other calendars" එක බලන්න.
3. "SLIIT Timetable" එකට ✅ Tick එකක් දාන්න!

⚠️ *පෙන්නන්නේ නැත්නම්:* "Other calendars" එක Check කරලා Auto-Sync ON කරන්න.`
                    }, { quoted: msg });
                    console.log('✅ [DEBUG] calendar link reply sent');
                    return;
                }

                // ---------- CALENDAR HELP ----------
                if (textLower === 'calendar help' || textLower === 'calendar not showing' || textLower === 'sync calendar') {
                    console.log('📅 [DEBUG] calendar help command detected');
                    await sock.sendMessage(sender, {
                        text: `📅 *Calendar Troubleshooting Guide*

🔗 *Link:*
https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t

*✅ Step 1:* Google Calendar App → ☰ Menu → "Other calendars" → "SLIIT Timetable" ✅ Check කරන්න.

*✅ Step 2:* Settings → Calendar → Accounts → Google → ඔබගේ SLIIT email එක → Calendars ON කරන්න.

*✅ Step 3:* Settings → Accounts → Google → SLIIT account → Calendar Sync ON කරන්න.

*✅ Step 4:* Unsubscribe කරලා නැවත Add කරන්න.

📱 *Still not working?* Contact Batch Rep: +94 76 251 3957`
                    }, { quoted: msg });
                    console.log('✅ [DEBUG] calendar help reply sent');
                    return;
                }

                // ---------- SWAP REQUEST ----------
                const swapMatch = rawMessageText.match(/^swap\s*:?\s*(.+?)\s+(?:to|->|dakwa)\s+(.+)$/i);
                if (swapMatch) {
                    console.log('🔄 [DEBUG] swap command detected');
                    const rawFrom = swapMatch[1].trim();
                    const rawTo = swapMatch[2].trim();
                    const normFrom = normalizeGroupLabel(rawFrom);
                    const normTo = normalizeGroupLabel(rawTo);

                    if (!normFrom || !normTo) {
                        await sock.sendMessage(sender, { text: `⚠️ Format එක: "swap: 1 to 2" වගේ දෙන්න (current group → ඕන group).` }, { quoted: msg });
                        return;
                    }

                    swapRequests[sender] = {
                        fromGroup: normFrom,
                        toGroup: normTo,
                        rawFrom,
                        rawTo,
                        name: msg.pushName || 'Unknown',
                        timestamp: Date.now(),
                        matched: false,
                        matchedWith: null
                    };

                    const matchEntry = Object.entries(swapRequests).find(
                        ([jid, req]) => jid !== sender && !req.matched && req.fromGroup === normTo && req.toGroup === normFrom
                    );

                    if (matchEntry) {
                        const [matchedJid, matchedReq] = matchEntry;
                        swapRequests[sender].matched = true;
                        swapRequests[sender].matchedWith = matchedJid;
                        matchedReq.matched = true;
                        matchedReq.matchedWith = sender;
                        saveSwapRequests();

                        const myPhone = extractPhoneDisplay(sender);
                        const otherPhone = extractPhoneDisplay(matchedJid);

                        const otherContactLine = otherPhone
                            ? `📱 Contact: ${otherPhone}`
                            : `📱 Contact: group chat eke *${matchedReq.name}* kiyala hoyaganna.`;
                        const myContactLine = myPhone
                            ? `📱 Contact: ${myPhone}`
                            : `📱 Contact: group chat eke *${swapRequests[sender].name}* kiyala hoyaganna.`;

                        await sock.sendMessage(sender, {
                            text: `🎉 Match හම්බුනා! *${matchedReq.name}* ට ඔයාට ${matchedReq.rawFrom} → ${matchedReq.rawTo} swap කරන්න ඕන.\n${otherContactLine}\n\nඑයාව contact කරලා, "Lab Group Change Request Form" එකට **එක කෙනෙක් විතරක්** fill කරලා Friday 28 Aug 11:59 AM ට කලින් submit කරන්න! ✅`
                        }, { quoted: msg });
                        await sock.sendMessage(matchedJid, {
                            text: `🎉 Match හම්බුනා! *${swapRequests[sender].name}* ට ඔයාට ${rawFrom} → ${rawTo} swap කරන්න ඕන.\n${myContactLine}\n\nඑයාව contact කරලා, "Lab Group Change Request Form" එකට **එක කෙනෙක් විතරක්** fill කරලා Friday 28 Aug 11:59 AM ට කලින් submit කරන්න! ✅`
                        });
                    } else {
                        saveSwapRequests();
                        await sock.sendMessage(sender, {
                            text: `✅ Request save කළා: Group ${rawFrom} → Group ${rawTo}.\n\nඅනිත් direction එකේ (Group ${rawTo} → Group ${rawFrom}) swap ඕන කෙනෙක් register වුනු ගමන්, ඔයාට automatic ලෙස notify කරන්නම්! 🔔`
                        }, { quoted: msg });
                    }
                    console.log('✅ [DEBUG] swap reply sent');
                    return;
                }

                // ---------- LIST SWAPS (Admin) ----------
                if (textLower === 'list swaps' || textLower === 'show swaps') {
                    console.log('📋 [DEBUG] list swaps command detected');
                    if (!isSenderAdmin(sender)) {
                        await sock.sendMessage(sender, { text: "❌ මේක බලන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                        return;
                    }
                    const entries = Object.entries(swapRequests);
                    if (entries.length === 0) {
                        await sock.sendMessage(sender, { text: "📭 දැනට swap requests නෑ." }, { quoted: msg });
                    } else {
                        const list = entries.map(([jid, req], i) =>
                            `${i+1}. ${req.name} (${extractPhoneDisplay(jid) || 'LID account'}): ${req.rawFrom} → ${req.rawTo} ${req.matched ? '✅ Matched' : '⏳ Waiting'}`
                        ).join('\n');
                        await sock.sendMessage(sender, { text: `🔄 *Swap Requests (${entries.length})*\n\n${list}` }, { quoted: msg });
                    }
                    console.log('✅ [DEBUG] list swaps reply sent');
                    return;
                }

                // ---------- CLEAR SWAPS (Admin) ----------
                if (textLower === 'clear swaps') {
                    console.log('🗑️ [DEBUG] clear swaps command detected');
                    if (!isSenderAdmin(sender)) {
                        await sock.sendMessage(sender, { text: "❌ මේක කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                        return;
                    }
                    swapRequests = {};
                    saveSwapRequests();
                    await sock.sendMessage(sender, { text: "🗑️ Swap requests ඔක්කොම clear කළා." }, { quoted: msg });
                    console.log('✅ [DEBUG] clear swaps reply sent');
                    return;
                }

                // ---------- LIST FILES (Admin) ----------
                if (textLower === 'list files' || textLower === 'show files') {
                    console.log('📁 [DEBUG] list files command detected');
                    if (!isSenderAdmin(sender)) {
                        await sock.sendMessage(sender, { text: "❌ මේක බලන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                        return;
                    }
                    if (fileRegistry.length === 0) {
                        await sock.sendMessage(sender, { text: "📭 දැනට files මොකවත් save කරලා නෑ." }, { quoted: msg });
                    } else {
                        const list = fileRegistry.map((f, i) => `${i+1}. "${f.keyword}" → ${f.fileName}`).join('\n');
                        await sock.sendMessage(sender, { text: `📁 *Saved Files (${fileRegistry.length})*\n\n${list}` }, { quoted: msg });
                    }
                    console.log('✅ [DEBUG] list files reply sent');
                    return;
                }

                // ---------- REMOVE FILE (Admin) ----------
                if (/^remove file\s+\d+/i.test(textLower)) {
                    console.log('🗑️ [DEBUG] remove file command detected');
                    if (!isSenderAdmin(sender)) {
                        await sock.sendMessage(sender, { text: "❌ මේක කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                        return;
                    }
                    const idx = parseInt(textLower.replace(/^remove file\s+/i, ''), 10) - 1;
                    if (isNaN(idx) || idx < 0 || idx >= fileRegistry.length) {
                        await sock.sendMessage(sender, { text: "⚠️ Number එක වැරදියි. 'list files' කියලා type කරලා number එක check කරන්න." }, { quoted: msg });
                        return;
                    }
                    const [removedFile] = fileRegistry.splice(idx, 1);
                    saveFileRegistry();
                    try {
                        const filePath = path.join(FILES_DIR, removedFile.storedFileName);
                        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                    } catch (e) { console.error('Error deleting file:', e); }
                    await sock.sendMessage(sender, { text: `🗑️ ඉවත් කළා: "${removedFile.keyword}" (${removedFile.fileName})` }, { quoted: msg });
                    console.log('✅ [DEBUG] remove file reply sent');
                    return;
                }

                // ---------- FILE DELIVERY ----------
                const matchedFile = fileRegistry.find((f) => textLower.includes(f.keyword));
                if (matchedFile) {
                    console.log('📤 [DEBUG] File delivery triggered for keyword:', matchedFile.keyword);
                    try {
                        const buffer = fs.readFileSync(path.join(FILES_DIR, matchedFile.storedFileName));
                        await sock.sendMessage(sender, {
                            document: buffer,
                            mimetype: matchedFile.mimetype,
                            fileName: matchedFile.fileName
                        }, { quoted: msg });
                        console.log('✅ [DEBUG] File delivered');
                    } catch (err) {
                        console.error('Error sending file:', err);
                        await sock.sendMessage(sender, { text: "❌ File එක එවීමේදී Error එකක් ආවා." }, { quoted: msg });
                    }
                    return;
                }

                // ---------- ADD INFO (Admin) ----------
                if (/^(add info|info add|save info)\b/i.test(textLower)) {
                    console.log('📝 [DEBUG] add info command detected');
                    if (!isSenderAdmin(sender)) {
                        await sock.sendMessage(sender, { text: "❌ මේක කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                        return;
                    }
                    const infoText = rawMessageText.replace(/^(add info|info add|save info)\s*:?\s*/i, '').trim();
                    if (!infoText) {
                        await sock.sendMessage(sender, { text: `⚠️ Info text එකත් එක්කම type කරන්න.` }, { quoted: msg });
                        return;
                    }
                    knowledgeBase.push(infoText);
                    saveKnowledgeBase();
                    await sock.sendMessage(sender, { text: `✅ Info එක save කළා! (Total: ${knowledgeBase.length})` }, { quoted: msg });
                    console.log('✅ [DEBUG] add info reply sent');
                    return;
                }

                // ---------- LIST INFO (Admin) ----------
                if (textLower === 'list info' || textLower === 'show info') {
                    console.log('📚 [DEBUG] list info command detected');
                    if (!isSenderAdmin(sender)) {
                        await sock.sendMessage(sender, { text: "❌ මේක බලන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                        return;
                    }
                    if (knowledgeBase.length === 0) {
                        await sock.sendMessage(sender, { text: "📭 දැනට info මොකවත් save කරලා නෑ." }, { quoted: msg });
                    } else {
                        const list = knowledgeBase.map((k, i) => `${i+1}. ${k}`).join('\n\n');
                        await sock.sendMessage(sender, { text: `📚 *Saved Info (${knowledgeBase.length})*\n\n${list}` }, { quoted: msg });
                    }
                    console.log('✅ [DEBUG] list info reply sent');
                    return;
                }

                // ---------- REMOVE INFO (Admin) ----------
                if (/^remove info\s+\d+/i.test(textLower)) {
                    console.log('🗑️ [DEBUG] remove info command detected');
                    if (!isSenderAdmin(sender)) {
                        await sock.sendMessage(sender, { text: "❌ මේක කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                        return;
                    }
                    const idx = parseInt(textLower.replace(/^remove info\s+/i, ''), 10) - 1;
                    if (isNaN(idx) || idx < 0 || idx >= knowledgeBase.length) {
                        await sock.sendMessage(sender, { text: "⚠️ Number එක වැරදියි. 'list info' කියලා type කරලා number එක check කරන්න." }, { quoted: msg });
                        return;
                    }
                    const removed = knowledgeBase.splice(idx, 1);
                    saveKnowledgeBase();
                    await sock.sendMessage(sender, { text: `🗑️ ඉවත් කළා: "${removed[0]}"` }, { quoted: msg });
                    console.log('✅ [DEBUG] remove info reply sent');
                    return;
                }

                // ---------- AI RESPONSE ----------
                if (rawMessageText) {
                    console.log('🤖 [DEBUG] Sending to Gemini...');
                    console.log('📝 [DEBUG] fullUserPrompt:', fullUserPrompt);
                    try {
                        const result = await model.generateContent(buildPromptWithKnowledge(fullUserPrompt));
                        const reply = formatMathForWhatsApp(result.response.text());
                        console.log('✅ [DEBUG] Gemini reply received:', reply.substring(0, 100) + '...');
                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                        console.log('✅ [DEBUG] Reply sent!');
                    } catch (error) {
                        console.error('❌ [DEBUG] Gemini error:', error);
                    }
                } else {
                    console.log('⚠️ [DEBUG] rawMessageText is empty, skipping AI response');
                }
            }
        }

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            console.log('📨 [DEBUG] messages.upsert triggered! Type:', type);
            if (type !== 'notify') {
                console.log('⏭️ [DEBUG] Skipping - type is not notify');
                return;
            }
            console.log('📨 [DEBUG] Messages count:', messages.length);
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) {
                    console.log('⏭️ [DEBUG] Skipping - no message or fromMe');
                    continue;
                }
                console.log('🟢 [DEBUG] Processing message ID:', msg.key.id);

                if (processedMessages.has(msg.key.id)) {
                    console.log('⏭️ [DEBUG] Duplicate message, skipping');
                    continue;
                }
                markProcessed(msg.key.id);
                messageQueue.add(
                    () => processMessage(sock, msg),
                    async (position) => {
                        try {
                            await sock.sendMessage(msg.key.remoteJid, { text: `⏳ මචං, ටිකක් ඉන්න! Queue: ${position}. ඉක්මනටම reply කරන්නම්! 🙏` }, { quoted: msg });
                        } catch (e) { console.error('Failed to send queued notice:', e); }
                    }
                ).catch(err => console.error('Queued message processing failed:', err));
            }
        });

    } catch (error) {
        console.error('❌ Connection error:', error.message);
        console.log('🔄 Retrying in 5 seconds...');
        setTimeout(() => connectToWhatsApp(), 5000);
    }
}

// ======================================================================
// 🚀 START
// ======================================================================
connectToWhatsApp();
