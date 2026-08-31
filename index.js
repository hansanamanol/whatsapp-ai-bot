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
//  👑 ADMIN CONFIG (FIXED)
// ================================================================
const ADMIN_PHONE_NUMBER = "94762513957";
const ADMIN_LID = "178481912627279";
const ADMIN_JIDS = [`${ADMIN_LID}@lid`];  // ✅ backticks use කරන්න ඕන!

function isSenderAdmin(sender) {
    const normalized = jidNormalizedUser(sender) || sender;
    if (ADMIN_JIDS.includes(sender) || ADMIN_JIDS.includes(normalized)) return true;
    if (normalized === `${ADMIN_PHONE_NUMBER}@s.whatsapp.net`) return true;  // ✅ backticks
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

// ================================================================
//  🛡️ RATE LIMIT & ANTI-SPAM
// ================================================================
const rateLimitMap = {}; 

function checkRateLimit(userId) {
    const now = Date.now();
    const user = rateLimitMap[userId] || { count: 0, startTime: now, blockedUntil: 0 };

    if (now < user.blockedUntil) {
        return { allowed: false, reason: `⚠️ Spam එක නවත්තන්න! තත්පර ${Math.ceil((user.blockedUntil - now) / 1000)}ක් ඉන්න.` };
    }

    if (now - user.startTime > 5000) { // 5 seconds window
        user.count = 0;
        user.startTime = now;
    }

    user.count++;
    rateLimitMap[userId] = user;

    if (user.count > 5) { // Max 5 messages per 5 seconds
        user.blockedUntil = now + 60000; // Block for 60 seconds
        rateLimitMap[userId] = user;
        return { allowed: false, reason: "⚠️ ඕනෑවට වඩා ඉක්මනට Messages යවනවා. තත්පර 60ක් රැඳී සිටින්න." };
    }

    return { allowed: true, reason: "" };
}


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

const systemInstruction = `
You are HansanaBot, an intelligent Gemini AI assistant working for the SLIIT IT Batch Representative (Monal Hansana).

YOUR IDENTITY & RESPONSIBILITIES:
- Your Name: HansanaBot
- You assist the Batch Rep, Monal (Hansana), by helping SLIIT students with their academic queries.
- Answer student questions naturally in Singlish, Sinhala, or English based on the user's language.
- Assist students with Timetable info, Calendar link, Issue forms, LMS links, Course Outlines, and LIC contacts.
- Read images, voice notes, and PDFs provided by users accurately and explain them.

BATCH REPRESENTATIVE (MONAL HANSANA) CONTACT DETAILS:
- When students ask for Batch Rep's contact details, phone number, email, or how to contact Monal, provide the following details cleanly:
  * Name: Monal Hansana (SLIIT IT Batch Representative)
  * Contact Number: +94 76 251 3957 (076 251 3957)
  * Official SLIIT Email: it26100930@my.sliit.lk

Y1S2 MODULE DETAILS & LIC INFORMATION:
1. IT1170 - Data Structures and Algorithms (DSA)
   - LIC: Prof. Nathali Silva (nathali.s@sliit.lk)
   - Focus: Time/space complexity (Big-O analysis), RAM model, arrays, linked lists, stacks, queues, trees, graphs, sorting and searching algorithms.

2. IT1160 - Discrete Mathematics
   - LIC: Ms. Nipuni Maleesha (nipuni.m@sliit.lk)
   - Focus: Logic, sets, functions, relations, proof techniques, graph theory, combinatorics, and mathematical structures for computer science.

3. SE1020 - Object Oriented Programming (OOP)
   - LIC: Ms. Thilini Jayalath (thilini.j@sliit.lk)
   - Focus: OOP concepts (Abstraction, Encapsulation, Inheritance, Polymorphism), Java/C++ implementations, design principles.

4. IT1150 - Technical Writing
   - LIC: Ms. Dinushika Jayathissa (dinushika.j@sliit.lk)
   - Focus: Professional communication, writing technical documentation, research reports, email etiquette, presentation skills.

5. IE1011 - Information Systems
   - LIC: Ms. Chathurangika Kahandawarachchi (chathurangika.k@sliit.lk)
   - Focus: Business information systems, enterprise resource planning (ERP), system architecture, database concepts in business contexts.

ACADEMIC & UNIVERSITY RULES:
- Attendance: Minimum 80% attendance is strictly required for labs and lectures to sit for final exams.
- Assessments: Grade is based on Continuous Assessments (Quizzes, Mid-Exam, Lab Tests, Assignments) + Final Exam.
- Lab Group Switching: Changing Lab groups (G1/G2/etc.) requires prior LIC approval or valid medical reason.

IMPORTANT LINKS & PORTALS:
1. Timetable / Calendar: https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t
2. Courseweb (LMS): https://courseweb.sliit.lk/
3. Eduscope (Lecture Recordings): https://eduscope.sliit.lk/
4. Issue Reporting Form: https://docs.google.com/forms/d/e/1FAIpQLSfOUJnkMp8Tdig0C187WDOgU5AZmtPh3ayBZ-_z9xd23K3Zgw/viewform?usp=publish-editor
5. SLIIT Support Desk: https://ask.sliit.lk/

CRITICAL — NEVER CLAIM TO HAVE SENT/POSTED SOMETHING:
- You CANNOT actually send messages, post announcements, or perform any action outside this chat reply. That is handled separately by the bot's code, not by you.
- NEVER say things like "I've sent this to the group" or "yawanawa" / "දැම්මා" as if the action already happened. If a user asks you to post/send something to a group, simply explain that only the Batch Rep (Monal) can trigger that via a direct message with the correct phrasing, and do not simulate or pretend the action occurred.

CRITICAL CODE & TUTORIAL ANALYSIS RULES:
- When analyzing code snippets or tutorials:
  1. Pay EXTREME attention to variable scope and re-initialization (e.g., whether 'j = 1' is initialized OUTSIDE or INSIDE an outer loop).
  2. Distinguish clearly between Sequential/Consecutive loops and Nested loops. Do not multiply iterations unless one loop is strictly nested inside another.
  3. Keep track of accurate question labeling (a, b, c, d, e) without swapping their code contents.
`;

const model = genAI.getGenerativeModel({
    model: "gemini-3.1-flash-lite", 
    systemInstruction: systemInstruction
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
//  📅 CALENDAR READER (අලුත් කරපු logic එක)
// ================================================================
const CALENDAR_API_KEY = process.env.CALENDAR_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID || 'ca0b38d172729231657abfc34f1c7fdb8ea33050fe6f4623f5fab88cd0d4633@group.calendar.google.com';

// අද, හෙට, සඳුදා වගේ කියවලා දවස තෝරගන්න function එක
function getTargetDateRange(text) {
    const now = new Date();
    const targetDate = new Date(now);
    const lowerText = text.toLowerCase();

    if (lowerText.includes('tomorrow') || lowerText.includes('heta') || lowerText.includes('හෙට')) {
        targetDate.setDate(now.getDate() + 1);
    } else if (lowerText.includes('today') || lowerText.includes('ada') || lowerText.includes('අද')) {
        // default to today
    } else {
        // Specific days (Monday, Tuesday, etc.)
        const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
        const sinhalaDays = ['ඉරිදා','සඳුදා','අඟහරුවාදා','බදාදා','බ්‍රහස්පතින්දා','සිකුරාදා','සෙනසුරාදා'];
        for(let i=0; i<7; i++){
            if(lowerText.includes(days[i]) || lowerText.includes(sinhalaDays[i])){
                const diff = (i - now.getDay() + 7) % 7;
                targetDate.setDate(now.getDate() + diff);
                break;
            }
        }
    }

    const start = new Date(targetDate);
    start.setHours(0,0,0,0);
    const end = new Date(targetDate);
    end.setHours(23,59,59,999);

    return { start, end };
}

async function getCalendarEvents(start, end) {
    if (!CALENDAR_API_KEY) {
        console.warn('⚠️ CALENDAR_API_KEY not set. Calendar will not work.');
        return null;
    }
    const calendar = google.calendar({ version: 'v3', auth: CALENDAR_API_KEY });
    try {
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
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
                // ඇත්තම error එක බලන්න
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                console.error("❌ WhatsApp Connection Closed! Status Code:", statusCode);
                console.error("❌ Full Error:", lastDisconnect?.error);

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
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
                            // ---------- HELP MENU ----------
            if (textLower === 'help' || textLower === '/help' || textLower === 'menu' || textLower === '/menu' || textLower === 'start' || textLower === '/start' || textLower === 'commands') {
                const helpText = `👋 *HansanaBot Help Menu* 🤖

*General Commands:*
📌 *help* - මේ Menu එක පෙන්නනවා


*📅 Timetable & Calendar:*
🗓️ *calendar* - අද / හෙට / ඉදිරි දවස් වල Classes බලන්න
📅 *tomorrow* / *heta* - හෙට තියෙන Classes බලන්න
📅 *today* / *ada* - අද තියෙන Classes බලන්න
📅 *monday*, *tuesday*, *wednesday* etc. - ඒ දවසේ Classes බලන්න

*📁 Files & Documents:*
📂 *handbook*, *course outline* etc. - Save කරලා තියෙන Files ලබා ගන්න

*📞 Support:*
Contact Batch Rep: +94 76 251 3957
`;
                await sock.sendMessage(sender, { text: helpText }, { quoted: msg });
                return;
            }

            // WHOAMI ID
            if (textLower === 'whoami' || textLower === 'myid') {
                const normalized = jidNormalizedUser(sender) || sender;
                await sock.sendMessage(sender, { text: `🆔 Your ID: \`${normalized}\`` }, { quoted: msg });
                return;
            }

                        // 📅 CALENDAR (දැන් අද/හෙට/සතිය බලලා උත්තර දෙනවා)
            if (textLower === 'calendar' || textLower === 'timetable' || textLower === 'time' || textLower === 'calender' || textLower === 'class' || textLower === 'lab' || textLower === 'eta' || textLower.startsWith('today') || textLower.startsWith('tomorrow') || textLower.startsWith('heta') || textLower.startsWith('ada') || textLower.startsWith('monday') || textLower.startsWith('tuesday') || textLower.startsWith('wednesday') || textLower.startsWith('thursday') || textLower.startsWith('friday')) {
                const { start, end } = getTargetDateRange(textLower);
                const events = await getCalendarEvents(start, end);

                if (events && events.length > 0) {
                    let msgText = '📅 *ඒ දවසේ Classes:*\n\n';
                    events.forEach((ev, idx) => {
                        const startTime = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute:'2-digit' });
                        const endTime = new Date(ev.end?.dateTime || ev.end?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute:'2-digit' });
                        
                        // ⬇️ මේ අලුත් lines ටික add කරලා තියෙනවා (Location & Description)
                        const location = ev.location || '';
                        const description = ev.description || '';

                        msgText += `${idx+1}. *${ev.summary || 'Untitled'}*\n`;
                        msgText += `   🕒 ${startTime} – ${endTime}\n`;
                        
                        if (location) {
                            msgText += `   📍 *ස්ථානය (Location):* ${location}\n`;
                        }
                        if (description) {
                            // ⬇️ සම්පූර්ණ Description එකම පෙන්නනවා (කපන්නේ නෑ)
                            msgText += `   📝 *විස්තරය (Details):* ${description}\n`;
                        }
                        msgText += `\n`;
                        // ⬆️ ඉවරයි
                    });
                    msgText += `🔗 *Full Calendar:* https://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(CALENDAR_ID)}`;
                    await sock.sendMessage(sender, { text: msgText }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, { text: "🎉 ඒ දවසට විතරක් classes නෑ! (No lectures/labs for that day)." }, { quoted: msg });
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
