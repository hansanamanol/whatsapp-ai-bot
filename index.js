// ================================================================
//  📦 DEPENDENCIES
// ================================================================
require('dotenv').config();

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason,
        downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

ffmpeg.setFfmpegPath(ffmpegPath);

// ================================================================
//  👑 ADMIN CONFIG
// ================================================================
const ADMIN_PHONE_NUMBER = "94762513957";
const ADMIN_LID = "178481912627279";  // Corrected
const ADMIN_JIDS = [`${ADMIN_LID}@lid`];

function isSenderAdmin(sender) {
    const normalized = jidNormalizedUser(sender) || sender;
    if (ADMIN_JIDS.includes(sender) || ADMIN_JIDS.includes(normalized)) return true;
    if (normalized === `${ADMIN_PHONE_NUMBER}@s.whatsapp.net`) return true;
    if (ADMIN_LID && (normalized === `${ADMIN_LID}@lid` || sender.includes(ADMIN_LID))) return true;
    return sender.includes(ADMIN_PHONE_NUMBER);
}

// ================================================================
//  📚 KNOWLEDGE BASE
// ================================================================
const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge.json');
let knowledgeBase = [];
try {
    if (fs.existsSync(KNOWLEDGE_FILE)) knowledgeBase = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
} catch (e) { console.error('Error loading knowledge.json:', e); }

function saveKnowledgeBase() {
    try { fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledgeBase, null, 2)); } catch (e) { console.error(e); }
}

function buildPromptWithKnowledge(basePrompt) {
    if (knowledgeBase.length === 0) return basePrompt;
    const knowledgeText = knowledgeBase.map((k, i) => `${i+1}. ${k}`).join('\n');
    return `${basePrompt}\n\n[BATCH-SPECIFIC KNOWLEDGE — use if relevant:]\n${knowledgeText}`;
}

// ================================================================
//  📁 FILE REGISTRY
// ================================================================
const FILES_DIR = path.join(__dirname, 'resources');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
const FILE_REGISTRY_PATH = path.join(__dirname, 'files-registry.json');
let fileRegistry = [];
try {
    if (fs.existsSync(FILE_REGISTRY_PATH)) fileRegistry = JSON.parse(fs.readFileSync(FILE_REGISTRY_PATH, 'utf8'));
} catch (e) { console.error('Error loading files-registry.json:', e); }

function saveFileRegistry() {
    try { fs.writeFileSync(FILE_REGISTRY_PATH, JSON.stringify(fileRegistry, null, 2)); } catch (e) { console.error(e); }
}

// ================================================================
//  🔄 SWAP SYSTEM
// ================================================================
const SWAP_REQUESTS_FILE = path.join(__dirname, 'swap-requests.json');
let swapRequests = {};
try {
    if (fs.existsSync(SWAP_REQUESTS_FILE)) swapRequests = JSON.parse(fs.readFileSync(SWAP_REQUESTS_FILE, 'utf8'));
} catch (e) { console.error('Error loading swap-requests.json:', e); }

function saveSwapRequests() {
    try { fs.writeFileSync(SWAP_REQUESTS_FILE, JSON.stringify(swapRequests, null, 2)); } catch (e) { console.error(e); }
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

// ================================================================
//  🧵 CONCURRENCY QUEUE
// ================================================================
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
            if (willWait && typeof onQueued === 'function') onQueued(this.queue.length);
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

// ================================================================
//  🔁 MESSAGE DEDUP
// ================================================================
const processedMessages = new Set();
const MAX_TRACKED_MESSAGES = 1000;
function markProcessed(id) {
    processedMessages.add(id);
    if (processedMessages.size > MAX_TRACKED_MESSAGES) {
        const oldest = processedMessages.values().next().value;
        processedMessages.delete(oldest);
    }
}

// ================================================================
//  🚀 EXPRESS WEB SERVER
// ================================================================
const app = express();
const PORT = process.env.PORT || 3000;
let latestQR = "";
let isConnected = false;

app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send(`<html><head><title>HansanaBot — Connected</title><meta http-equiv="refresh" content="30"></head>
            <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
            <h2 style="color:#2ea043;">✅ Bot එක Connected & Running!</h2>
            <p style="color:#58a6ff;">WhatsApp Bot එක සාර්ථකව Connect වෙලා!</p>
            <p style="color:#8b949e;">ඔබට Bot එකට DM කරලා Test කරන්න පුළුවන්.</p>
            <p style="color:#8b949e;font-size:12px;margin-top:30px;">Page එක තත්පර 30කට වතාවක් Auto Refresh වෙයි</p>
            </body></html>`);
    }
    if (!latestQR) {
        return res.send(`<html><head><meta http-equiv="refresh" content="3"></head>
            <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
            <h2 style="color:#f0883e;">⏳ QR Code එක Loading...</h2>
            <p style="color:#8b949e;">තත්පර 3න් Auto Refresh වෙයි</p>
            </body></html>`);
    }
    try {
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`<html><head><title>WhatsApp Bot QR</title><meta http-equiv="refresh" content="15"></head>
            <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
            <h2 style="color:#58a6ff;">📱 Scan this QR Code with WhatsApp</h2>
            <img src="${qrImage}" style="border:10px solid white;border-radius:10px;width:300px;height:300px;"/>
            <p style="color:#8b949e;margin-top:20px;">QR Code එක Scan කරලා Bot එක Connect කරන්න</p>
            <p style="color:#8b949e;font-size:14px;">Page එක තත්පර 15කට වතාවක් Auto Refresh වෙයි</p>
            </body></html>`);
    } catch (err) {
        res.status(500).send('Error generating QR code');
    }
});

app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// ================================================================
//  🤖 GEMINI SETUP
// ================================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY not set. Exiting.');
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `
You are HansanaBot, assistant to SLIIT IT Batch Rep Monal Hansana.
- Answer in Singlish, Sinhala, or English based on user language.
- Provide timetable, LIC contacts, links, and academic info.
- NEVER claim to have sent/updated anything; you only reply in this chat.
- Use Unicode math symbols: ∪, ∩, ∈, ⊆, ∀, ∃, ≤, ≥, √, π, etc. NO LaTeX.
`
});

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
    for (const [pattern, symbol] of replacements) result = result.replace(pattern, symbol);
    return result;
}

// ================================================================
//  📅 CALENDAR READER
// ================================================================
const CALENDAR_API_KEY = process.env.CALENDAR_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID || 'ca0b38d172729231657abfc34f1c7fdb8ea33050fe6f4623f5fab88cd0d4633@group.calendar.google.com';

async function getCalendarEvents() {
    if (!CALENDAR_API_KEY) {
        console.warn('⚠️ CALENDAR_API_KEY not set. Calendar will not work.');
        return null;
    }
    const calendar = google.calendar({ version: 'v3', auth: CALENDAR_API_KEY });
    const now = new Date().toISOString();
    const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    try {
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: now,
            timeMax: weekLater,
            maxResults: 20,
            singleEvents: true,
            orderBy: 'startTime',
        });
        return response.data.items;
    } catch (error) {
        console.error('Calendar API error:', error.message);
        return null;
    }
}

// ================================================================
//  🎵 AUDIO CONVERSION
// ================================================================
function convertAudioToMp3(inputBuffer) {
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

// ================================================================
//  💬 MAIN MESSAGE PROCESSING
// ================================================================
async function connectToWhatsApp() {
    try {
        console.log('🔄 Loading auth state...');
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            badSessionDeleteHistory: true,
            retryRequestDelayMs: 2000,
            fireInitQueries: false,
            defaultQueryTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                latestQR = qr;
                isConnected = false;
                qrcodeTerminal.generate(qr, { small: true });
            }
            if (connection === 'close') {
                isConnected = false;
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                sock.ev.removeAllListeners();
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting in 3s...');
                    setTimeout(() => connectToWhatsApp().catch(console.error), 3000);
                } else {
                    console.log('Logged out. Exiting.');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                latestQR = "";
                isConnected = true;
                console.log('✅ WhatsApp AI Bot is Ready and Online!');
            }
        });

        // ----------------------------------------------------------------
        //  processMessage function
        // ----------------------------------------------------------------
        async function processMessage(sock, msg) {
            const sender = msg.key.remoteJid;
            const isGroup = sender.endsWith('@g.us');
            if (isGroup) return;

            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate('composing', sender);

            const imgMsg = msg.message.imageMessage || msg.message.viewOnceMessage?.message?.imageMessage ||
                           msg.message.viewOnceMessageV2?.message?.imageMessage || msg.message.ephemeralMessage?.message?.imageMessage;
            const audioMsg = msg.message.audioMessage || msg.message.viewOnceMessage?.message?.audioMessage ||
                             msg.message.ephemeralMessage?.message?.audioMessage;
            const docMsg = msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage ||
                           msg.message.ephemeralMessage?.message?.documentMessage;
            const firstMsgType = Object.keys(msg.message)[0];
            const contextInfo = msg.message[firstMsgType]?.contextInfo || msg.message.extendedTextMessage?.contextInfo;
            const quotedMsgObj = contextInfo?.quotedMessage;
            const quotedText = quotedMsgObj?.conversation || quotedMsgObj?.extendedTextMessage?.text ||
                               quotedMsgObj?.imageMessage?.caption || "";
            const rawMessageText = msg.message.conversation || msg.message.extendedTextMessage?.text ||
                                   imgMsg?.caption || docMsg?.caption || "";

            let fullUserPrompt = rawMessageText;
            if (quotedText) fullUserPrompt = `[Quoted: "${quotedText}"]\nUser: "${rawMessageText}"`;

            // ---------- AUDIO ----------
            if (audioMsg) {
                try {
                    await sock.sendMessage(sender, { text: "🎙️ **Voice Note Process වෙමින්...**" }, { quoted: msg });
                    const oggBuffer = await downloadMediaMessage(msg, 'buffer', {});
                    const mp3Buffer = await convertAudioToMp3(oggBuffer);
                    const base64Audio = mp3Buffer.toString('base64');
                    const audioPart = { inlineData: { data: base64Audio, mimeType: 'audio/mp3' } };
                    const prompt = buildPromptWithKnowledge("Listen to this audio and reply.");
                    const result = await model.generateContent([prompt, audioPart]);
                    const reply = formatMathForWhatsApp(result.response.text());
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                } catch (err) {
                    console.error('Audio error:', err);
                    await sock.sendMessage(sender, { text: "❌ Voice message එක process කරන්න බැරි වුණා." }, { quoted: msg });
                }
                return;
            }

            // ---------- ADD FILE (Admin) ----------
            if (docMsg && /^add file\b/i.test(rawMessageText.toLowerCase().trim())) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ මේක කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                const keyword = rawMessageText.replace(/^add file\s*:?\s*/i, '').trim().toLowerCase();
                if (!keyword) {
                    await sock.sendMessage(sender, { text: "⚠️ Keyword එකත් caption එකේ දෙන්න: add file: course outline" }, { quoted: msg });
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
                    await sock.sendMessage(sender, { text: `✅ File save කළා! Keyword: "${keyword}"` }, { quoted: msg });
                } catch (err) {
                    console.error('Save file error:', err);
                    await sock.sendMessage(sender, { text: "❌ File save කිරීම අසාර්ථකයි." }, { quoted: msg });
                }
                return;
            }

            // ---------- PDF ANALYSIS ----------
            if (docMsg) {
                try {
                    if (docMsg.mimetype === 'application/pdf') {
                        await sock.sendMessage(sender, { text: "📄 **PDF Read කරමින්...**" }, { quoted: msg });
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const base64Pdf = buffer.toString('base64');
                        const pdfPart = { inlineData: { data: base64Pdf, mimeType: 'application/pdf' } };
                        const prompt = buildPromptWithKnowledge(`Read PDF and respond. User: ${rawMessageText || ''}`);
                        const result = await model.generateContent([prompt, pdfPart]);
                        const reply = formatMathForWhatsApp(result.response.text());
                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                    }
                } catch (err) {
                    console.error('PDF error:', err);
                    await sock.sendMessage(sender, { text: "❌ PDF read කරගන්න බැරි වුණා." }, { quoted: msg });
                }
                return;
            }

            // ---------- IMAGE ----------
            if (imgMsg) {
                try {
                    await sock.sendMessage(sender, { text: "⏳ **Image Process වෙමින්...**" }, { quoted: msg });
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const base64Image = buffer.toString('base64');
                    const mimeType = imgMsg.mimetype || 'image/jpeg';
                    const imagePart = { inlineData: { data: base64Image, mimeType: mimeType } };
                    const prompt = buildPromptWithKnowledge(`Analyze image. User: ${rawMessageText || ''}`);
                    const result = await model.generateContent([prompt, imagePart]);
                    const reply = formatMathForWhatsApp(result.response.text());
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                } catch (err) {
                    console.error('Image error:', err);
                    await sock.sendMessage(sender, { text: "❌ Image process කරන්න බැරි වුණා." }, { quoted: msg });
                }
                return;
            }

            // ---------- TEXT COMMANDS ----------
            const textLower = rawMessageText.toLowerCase().trim();

            // WHO AM I
            if (/\bwho\s*am\s*i\b/i.test(textLower) || textLower.includes('man kauda') || textLower.includes('mama kauda')) {
                const isAdmin = isSenderAdmin(sender);
                if (isAdmin) {
                    await sock.sendMessage(sender, { text: `👋 ඔයා *Monal Hansana* — Batch Rep! ✅` }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, { text: `👤 ඔයා student කෙනෙක්.` }, { quoted: msg });
                }
                return;
            }

            // WHOAMI ID
            if (textLower === 'whoami' || textLower === 'myid') {
                const normalized = jidNormalizedUser(sender) || sender;
                await sock.sendMessage(sender, { text: `🆔 Your ID: \`${normalized}\`` }, { quoted: msg });
                return;
            }

            // 📅 CALENDAR (with events)
            if (textLower === 'calendar' || textLower === 'timetable' || textLower === 'time' || textLower === 'calender') {
                const events = await getCalendarEvents();
                if (events && events.length > 0) {
                    let msgText = '📅 *ඉදිරි සතියේ Timetable:*\n\n';
                    events.forEach((ev, idx) => {
                        const start = ev.start?.dateTime || ev.start?.date || '?';
                        const end = ev.end?.dateTime || ev.end?.date || '?';
                        const startTime = new Date(start).toLocaleString('en-LK', { timeZone: 'Asia/Colombo' });
                        const endTime = new Date(end).toLocaleString('en-LK', { timeZone: 'Asia/Colombo' });
                        msgText += `${idx+1}. *${ev.summary || 'Untitled'}*\n   🕒 ${startTime} – ${endTime}\n\n`;
                    });
                    msgText += `🔗 *Full Calendar:* https://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(CALENDAR_ID)}`;
                    await sock.sendMessage(sender, { text: msgText }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, {
                        text: `📅 *SLIIT Timetable Link:*\nhttps://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(CALENDAR_ID)}`
                    }, { quoted: msg });
                }
                return;
            }

            // CALENDAR HELP
            if (textLower === 'calendar help' || textLower === 'calendar not showing' || textLower === 'sync calendar') {
                await sock.sendMessage(sender, {
                    text: `📅 *Calendar Troubleshooting*\n\n🔗 Link: https://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(CALENDAR_ID)}\n\n*Steps:*\n1. Google Calendar App → ☰ Menu → "Other calendars" → Check "SLIIT Timetable".\n2. Settings → Accounts → Google → SLIIT email → Calendars ON.\n3. Settings → Accounts → Sync Calendar ON.\n4. Unsubscribe and re-add.\n\n📱 Still not working? Contact Batch Rep: +94 76 251 3957`
                }, { quoted: msg });
                return;
            }

            // SWAP
            const swapMatch = rawMessageText.match(/^swap\s*:?\s*(.+?)\s+(?:to|->|dakwa)\s+(.+)$/i);
            if (swapMatch) {
                const rawFrom = swapMatch[1].trim();
                const rawTo = swapMatch[2].trim();
                const normFrom = normalizeGroupLabel(rawFrom);
                const normTo = normalizeGroupLabel(rawTo);
                if (!normFrom || !normTo) {
                    await sock.sendMessage(sender, { text: `⚠️ Format: "swap: 1 to 2"` }, { quoted: msg });
                    return;
                }
                swapRequests[sender] = {
                    fromGroup: normFrom, toGroup: normTo, rawFrom, rawTo,
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
                    const otherLine = otherPhone ? `📱 Contact: ${otherPhone}` : `📱 Contact: *${matchedReq.name}* in group.`;
                    const myLine = myPhone ? `📱 Contact: ${myPhone}` : `📱 Contact: *${swapRequests[sender].name}* in group.`;
                    await sock.sendMessage(sender, {
                        text: `🎉 Match! *${matchedReq.name}* wants ${matchedReq.rawFrom}→${matchedReq.rawTo}.\n${otherLine}\nContact and submit Lab Change Form by Friday 28 Aug 11:59 AM.`
                    }, { quoted: msg });
                    await sock.sendMessage(matchedJid, {
                        text: `🎉 Match! *${swapRequests[sender].name}* wants ${rawFrom}→${rawTo}.\n${myLine}\nContact and submit form by Friday 28 Aug 11:59 AM.`
                    });
                } else {
                    saveSwapRequests();
                    await sock.sendMessage(sender, {
                        text: `✅ Request saved: ${rawFrom} → ${rawTo}. Will notify when a match appears.`
                    }, { quoted: msg });
                }
                return;
            }

            // LIST SWAPS (Admin)
            if (textLower === 'list swaps' || textLower === 'show swaps') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const entries = Object.entries(swapRequests);
                if (entries.length === 0) await sock.sendMessage(sender, { text: "📭 No swap requests." }, { quoted: msg });
                else {
                    const list = entries.map(([jid, req], i) =>
                        `${i+1}. ${req.name} (${extractPhoneDisplay(jid) || 'LID'}): ${req.rawFrom}→${req.rawTo} ${req.matched ? '✅ Matched' : '⏳ Waiting'}`
                    ).join('\n');
                    await sock.sendMessage(sender, { text: `🔄 *Swap Requests (${entries.length})*\n\n${list}` }, { quoted: msg });
                }
                return;
            }

            // CLEAR SWAPS (Admin)
            if (textLower === 'clear swaps') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                swapRequests = {};
                saveSwapRequests();
                await sock.sendMessage(sender, { text: "🗑️ All swap requests cleared." }, { quoted: msg });
                return;
            }

            // LIST FILES (Admin)
            if (textLower === 'list files' || textLower === 'show files') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                if (fileRegistry.length === 0) await sock.sendMessage(sender, { text: "📭 No files saved." }, { quoted: msg });
                else {
                    const list = fileRegistry.map((f, i) => `${i+1}. "${f.keyword}" → ${f.fileName}`).join('\n');
                    await sock.sendMessage(sender, { text: `📁 *Saved Files (${fileRegistry.length})*\n\n${list}` }, { quoted: msg });
                }
                return;
            }

            // REMOVE FILE (Admin)
            if (/^remove file\s+\d+/i.test(textLower)) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const idx = parseInt(textLower.replace(/^remove file\s+/i, ''), 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= fileRegistry.length) {
                    await sock.sendMessage(sender, { text: "⚠️ Invalid number. Use 'list files' to see." }, { quoted: msg });
                    return;
                }
                const [removed] = fileRegistry.splice(idx, 1);
                saveFileRegistry();
                try {
                    const filePath = path.join(FILES_DIR, removed.storedFileName);
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch (e) { console.error('Delete file error:', e); }
                await sock.sendMessage(sender, { text: `🗑️ Removed: "${removed.keyword}"` }, { quoted: msg });
                return;
            }

            // FILE DELIVERY (strict word match)
            const matchedFile = fileRegistry.find(f => new RegExp(`\\b${f.keyword}\\b`, 'i').test(textLower));
            if (matchedFile) {
                try {
                    const buffer = fs.readFileSync(path.join(FILES_DIR, matchedFile.storedFileName));
                    await sock.sendMessage(sender, {
                        document: buffer,
                        mimetype: matchedFile.mimetype,
                        fileName: matchedFile.fileName
                    }, { quoted: msg });
                } catch (err) {
                    console.error('Send file error:', err);
                    await sock.sendMessage(sender, { text: "❌ File send කිරීම අසාර්ථකයි." }, { quoted: msg });
                }
                return;
            }

            // ADD INFO (Admin)
            if (/^(add info|info add|save info)\b/i.test(textLower)) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const infoText = rawMessageText.replace(/^(add info|info add|save info)\s*:?\s*/i, '').trim();
                if (!infoText) {
                    await sock.sendMessage(sender, { text: "⚠️ Please provide info text." }, { quoted: msg });
                    return;
                }
                knowledgeBase.push(infoText);
                saveKnowledgeBase();
                await sock.sendMessage(sender, { text: `✅ Info saved! (Total: ${knowledgeBase.length})` }, { quoted: msg });
                return;
            }

            // LIST INFO (Admin)
            if (textLower === 'list info' || textLower === 'show info') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                if (knowledgeBase.length === 0) await sock.sendMessage(sender, { text: "📭 No info saved." }, { quoted: msg });
                else {
                    const list = knowledgeBase.map((k, i) => `${i+1}. ${k}`).join('\n\n');
                    await sock.sendMessage(sender, { text: `📚 *Saved Info (${knowledgeBase.length})*\n\n${list}` }, { quoted: msg });
                }
                return;
            }

            // REMOVE INFO (Admin)
            if (/^remove info\s+\d+/i.test(textLower)) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const idx = parseInt(textLower.replace(/^remove info\s+/i, ''), 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= knowledgeBase.length) {
                    await sock.sendMessage(sender, { text: "⚠️ Invalid number. Use 'list info'." }, { quoted: msg });
                    return;
                }
                const removed = knowledgeBase.splice(idx, 1);
                saveKnowledgeBase();
                await sock.sendMessage(sender, { text: `🗑️ Removed: "${removed[0]}"` }, { quoted: msg });
                return;
            }

            // ---------- GENERAL AI RESPONSE ----------
            if (rawMessageText) {
                try {
                    const result = await model.generateContent(buildPromptWithKnowledge(fullUserPrompt));
                    const reply = formatMathForWhatsApp(result.response.text());
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                } catch (error) {
                    console.error('Gemini error:', error);
                    await sock.sendMessage(sender, { text: "❌ සමාවෙන්න, මට දැන් උත්තර දෙන්න බැරි වුණා. නැවත try කරන්න." }, { quoted: msg });
                }
            }
        }

        // ----------------------------------------------------------------
        //  messages.upsert handler
        // ----------------------------------------------------------------
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;
                if (processedMessages.has(msg.key.id)) continue;
                markProcessed(msg.key.id);
                messageQueue.add(
                    () => processMessage(sock, msg),
                    async (position) => {
                        try {
                            await sock.sendMessage(msg.key.remoteJid, { text: `⏳ ඉන්න! Queue: ${position}. ඉක්මනට reply කරන්නම්! 🙏` }, { quoted: msg });
                        } catch (e) { /* ignore */ }
                    }
                ).catch(err => console.error('Queue error:', err));
            }
        });

    } catch (error) {
        console.error('Connection error:', error);
        setTimeout(() => connectToWhatsApp(), 5000);
    }
}

// ================================================================
//  🚀 START
// ================================================================
connectToWhatsApp();
