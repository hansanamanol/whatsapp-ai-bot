// ================================================================
//  📦 DEPENDENCIES
// ================================================================
require('dotenv').config();
const cron = require('node-cron');

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
const ADMIN_LID = "178481912627279";
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
//  📇 STUDENT REGISTRY
// ================================================================
const STUDENTS_FILE = path.join(__dirname, 'students.json');
let studentRegistry = [];
try {
    if (fs.existsSync(STUDENTS_FILE)) studentRegistry = JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8'));
} catch (e) { console.error('Error loading students.json:', e); }

function saveStudents() {
    try { fs.writeFileSync(STUDENTS_FILE, JSON.stringify(studentRegistry, null, 2)); } catch (e) { console.error(e); }
}

function addStudent(jid) {
    if (!studentRegistry.includes(jid)) {
        studentRegistry.push(jid);
        saveStudents();
        console.log('📇 New student registered:', jid);
    }
}

let geminiRequestsToday = 0;

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
//  🧠 CONVERSATION MEMORY
// ================================================================
const userMemory = {};

function getRecentContext(userId) {
    const history = userMemory[userId];
    if (!history || history.length === 0) return "";
    return history.map(msg => `${msg.role}: ${msg.text}`).join("\n");
}

function addToMemory(userId, role, text) {
    if (!userMemory[userId]) userMemory[userId] = [];
    userMemory[userId].push({ role, text });
    if (userMemory[userId].length > 10) { 
        userMemory[userId].shift();
    }
}

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
//  🛡️ RATE LIMIT & ANTI-SPAM (Memory Leak Fix එක ඇතුළත්)
// ================================================================
const rateLimitMap = {}; 

// ⏰ Memory Leak Fix - පැය 1කට සැරයක් පරණ Data හිස් කිරීම
setInterval(() => {
    const now = Date.now();
    for (const userId in rateLimitMap) {
        if (now - rateLimitMap[userId].startTime > 3600000) {
            delete rateLimitMap[userId];
        }
    }
}, 3600000);

function checkRateLimit(userId) {
    const now = Date.now();
    const user = rateLimitMap[userId] || { count: 0, startTime: now, blockedUntil: 0 };

    if (now < user.blockedUntil) {
        return { allowed: false, reason: `⚠️ Spam එක නවත්තන්න! තත්පර ${Math.ceil((user.blockedUntil - now) / 1000)}ක් ඉන්න.` };
    }

    if (now - user.startTime > 5000) {
        user.count = 0;
        user.startTime = now;
    }

    user.count++;
    rateLimitMap[userId] = user;

    if (user.count > 5) {
        user.blockedUntil = now + 60000;
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
You are HansanaBot, the official digital assistant representing the SLIIT IT Y1S2 Batch Representative, Monal Hansana.

YOUR PERSONALITY & TONE:
- Your tone must ALWAYS be professional, helpful, polite, and warm.
- Address students respectfully (e.g., "ඔබට", "ඔයාට").
- Provide neatly formatted answers (use bullet points and bold text).
- NEVER give random, unrelated, or excessively long raw information. Always answer the specific question asked by the student.

RULES FOR KNOWLEDGE BASE:
- When you have information in your Knowledge Base (add info), give exactly the requested details in a structured, clean manner.
- If the info is about Fees, Dates, LIC, or Links, present them clearly so the student understands instantly.

BATCH REPRESENTATIVE (MONAL HANSANA) CONTACT DETAILS:
- When students ask for Batch Rep's contact details, phone number, email, or how to contact Monal, provide these details cleanly:
  * Name: Monal Hansana (SLIIT IT Y1S2 Batch Representative)
  * Contact Number: +94 76 251 3957 (076 251 3957)
  * Official SLIIT Email: it26100930@my.sliit.lk

Y1S2 MODULE DETAILS & LIC INFORMATION (Use this when asked):
1. IT1170 - DSA -> LIC: Prof. Nathali Silva (nathali.s@sliit.lk)
2. IT1160 - Discrete Math -> LIC: Ms. Nipuni Maleesha (nipuni.m@sliit.lk)
3. SE1020 - OOP -> LIC: Ms. Thilini Jayalath (thilini.j@sliit.lk)
4. IT1150 - Technical Writing -> LIC: Ms. Dinushika Jayathissa (dinushika.j@sliit.lk)
5. IE1011 - Information Systems -> LIC: Ms. Chathurangika Kahandawarachchi (chathurangika.k@sliit.lk)

ACADEMIC & UNIVERSITY RULES:
- Minimum 80% attendance is strictly required to sit for final exams.
- Grade is based on Continuous Assessments + Final Exam.
- Lab Group Switching requires prior LIC approval.

IMPORTANT LINKS:
1. Timetable / Calendar: https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t
2. Courseweb (LMS): https://courseweb.sliit.lk/
3. Eduscope (Lecture Recordings): https://eduscope.sliit.lk/
4. Issue Reporting Form: https://docs.google.com/forms/d/e/1FAIpQLSfOUJnkMp8Tdig0C187WDOgU5AZmtPh3ayBZ-_z9xd23K3Zgw/viewform?usp=dialog
5. SLIIT Support Desk: https://ask.sliit.lk/

CRITICAL — NEVER CLAIM TO HAVE SENT/POSTED SOMETHING:
- You CANNOT actually send messages, post announcements, or perform any action outside this chat reply.
- NEVER say things like "I've sent this to the group" or "yawanawa" / "දැම්මා".
- If a user asks you to post/send something, explain that only the Batch Rep (Monal) can trigger that.

CRITICAL CODE & TUTORIAL ANALYSIS RULES:
- When analyzing code snippets or tutorials:
  1. Pay EXTREME attention to variable scope and re-initialization (e.g., whether 'j = 1' is initialized OUTSIDE or INSIDE an outer loop).
  2. Distinguish clearly between Sequential/Consecutive loops and Nested loops.
  3. Keep track of accurate question labeling (a, b, c, d, e) without swapping their code contents.
`;

const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash-lite", 
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

// AI Intent Function
async function getCalendarIntentFromAI(text) {
    const prompt = `
    You are a highly accurate intent classifier for a University WhatsApp Bot.
    Analyze the user's message below. The user is asking about their SLIIT timetable.
    Identify if they are asking for a schedule for a specific day ("ada", "heta", "anidda", "pereda", "monday", "september 3" etc.), or if they are just chatting.
    Rules:
    - ONLY classify as 'calendar' if they are asking for a class schedule.
    - If they are just chatting (e.g., "adaraya", "kohomada", "hello"), classify as 'chat'.
    - If they are saving info (starts with "Add info"), classify as 'add_info'.
    - Respond with ONLY a JSON object in this exact format:
    { "intent": "calendar", "date_keyword": "anidda" }
    { "intent": "chat", "date_keyword": null }
    { "intent": "add_info", "date_keyword": null }
    
    User text: "${text}"
    `;

    try {
        geminiRequestsToday++;
        const result = await model.generateContent(prompt);
        const rawText = result.response.text().trim();
        const jsonMatch = rawText.match(/\{.*\}/s);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (e) {
        console.error('Intent parsing error:', e);
    }
    return { intent: "chat", date_keyword: null };
}

// HTML පෙරහන් Function එක
function cleanHTML(text) {
    if (!text) return '';
    let cleanText = text;
    cleanText = cleanText.replace(/<[^>]*>/g, '');
    cleanText = cleanText.replace(/&amp;/g, '&');
    cleanText = cleanText.replace(/&lt;/g, '<');
    cleanText = cleanText.replace(/&gt;/g, '>');
    cleanText = cleanText.replace(/&quot;/g, '"');
    cleanText = cleanText.replace(/&#39;/g, "'");
    cleanText = cleanText.replace(/&nbsp;/g, ' ');
    cleanText = cleanText.replace(/\n\s*\n/g, '\n').trim();
    return cleanText;
}

// ================================================================
//  📅 CALENDAR READER (Regex Fix "adaraya")
// ================================================================
const CALENDAR_API_KEY = process.env.CALENDAR_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID || 'ca0b38d172729231657abfc34f1c7fdb8ea33050fe6f4623f5fab88cd0d4633@group.calendar.google.com';

function getTargetDateRange(text) {
    const now = new Date();
    const targetDate = new Date(now);
    const lowerText = text.toLowerCase();

    // වැදගත්: /\bada\b/ සහ /\bheta\b/ ලෙස වෙනස් කළා (ඒ නිසා "adaraya" වලට හසු නොවේ)
    if (lowerText.includes('tomorrow') || /\bheta\b/.test(lowerText) || lowerText.includes('හෙට')) {
        targetDate.setDate(now.getDate() + 1);
    } else if (lowerText.includes('today') || /\bada\b/.test(lowerText) || lowerText.includes('අද')) {
        // default to today
    } else if (lowerText.includes('anidda') || lowerText.includes('inannida') || lowerText.includes('අනිද්දා')) {
        targetDate.setDate(now.getDate() + 2);
    } else if (lowerText.includes('pereda') || lowerText.includes('පෙරේදා')) {
        targetDate.setDate(now.getDate() - 2);
    } else if (lowerText.includes('iyye') || lowerText.includes('ඊයේ')) {
        targetDate.setDate(now.getDate() - 1);
    } else {
        const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
        const sinhalaDays = ['ඉරිදා','සඳුදා','අඟහරුවාදා','බදාදා','බ්‍රහස්පතින්දා','සිකුරාදා','සෙනසුරාදා'];
        let isDayFound = false;
        for(let i=0; i<7; i++){
            if(lowerText.includes(days[i]) || lowerText.includes(sinhalaDays[i])){
                const diff = (i - now.getDay() + 7) % 7;
                targetDate.setDate(now.getDate() + diff);
                isDayFound = true;
                break;
            }
        }

        if (!isDayFound) {
            const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
            let match = lowerText.match(/(\d{1,2})(?:st|nd|rd|th)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)/i);
            if (!match) match = lowerText.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{1,2})(?:st|nd|rd|th)?/i);
            
            if (match) {
                const monthIndex = monthNames.indexOf(match[1].toLowerCase());
                const day = parseInt(match[2]);
                if (monthIndex !== -1) {
                    targetDate.setMonth(monthIndex);
                    targetDate.setDate(day);
                    if (targetDate < now) {
                        targetDate.setFullYear(now.getFullYear() + 1);
                    }
                }
            }
        }
    }

    const start = new Date(targetDate);
    start.setHours(0,0,0,0);
    const end = new Date(targetDate);
    end.setHours(23,59,59,999);
    return { start, end, targetDate };
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
//  ⏰ DAILY TIMETABLE AUTO-PUSH FUNCTION
// ================================================================
async function sendDailyTimetable(sock) {
    if (studentRegistry.length === 0) {
        console.log('No students registered yet, skipping daily push.');
        return;
    }

    const { start, end, targetDate } = getTargetDateRange('today');
    const events = await getCalendarEvents(start, end);
    const formattedDate = targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' });

    let msgText = `🌅 *Good Morning!* අද දවසේ Classes:\n📅 *${formattedDate}*\n\n`;

    if (events && events.length > 0) {
        events.forEach((ev, idx) => {
            const startTime = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' });
            const endTime = new Date(ev.end?.dateTime || ev.end?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' });
            const location = ev.location || '';
            msgText += `${idx + 1}. *${ev.summary || 'Untitled'}*\n   🕒 ${startTime} - ${endTime}\n`;
            if (location) msgText += `   📍 ${location}\n\n`;
        });
    } else {
        msgText += "🎉 අද Classes නෑ! Free Day! 💯";
    }

    msgText += `\n💡 *Tip:* පාඩම් කරන්න \`quiz\` කියලා type කරන්න!`;

    for (const jid of studentRegistry) {
        try {
            await sock.sendMessage(jid, { text: msgText });
            await new Promise(r => setTimeout(r, 2000)); // WhatsApp Block නොවීමට Delay
        } catch (e) {
            console.error(`Failed to send to ${jid}:`, e.message);
        }
    }
    console.log('✅ Daily Timetable pushed to all students!');
}

// ================================================================
//  🎵 AUDIO CONVERSION (Temp Files Cleanup)
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
                } catch (e) { 
                    // අමතර ආරක්ෂාව - Cleanup
                    if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                    if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
                    reject(e); 
                }
            })
            .on('error', (err) => {
                // ✅ Temp Files Cleanup
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

        // ⏰ CRON JOB - හැමදාම උදේ 5:00 ට (Sri Lanka වෙලාවෙන්)
        cron.schedule('0 5 * * *', async () => {
            console.log('⏰ Running Daily Timetable Push at 5:00 AM SL Time...');
            await sendDailyTimetable(sock);
        }, { timezone: 'Asia/Colombo' });

        // ----------------------------------------------------------------
        //  processMessage function
        // ----------------------------------------------------------------
        async function processMessage(sock, msg) {
            const sender = msg.key.remoteJid;
            addStudent(sender);

            const rateCheck = checkRateLimit(sender);
            if (!rateCheck.allowed) {
                await sock.sendMessage(sender, { text: rateCheck.reason }, { quoted: msg });
                return;
            }   
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
                        keyword, fileName: docMsg.fileName || `${keyword}${ext}`,
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
                    await sock.sendMessage(sender, { text: "❌ File එක විවෘත කරන්න බැරි වුණා. ආයේ උත්සාහ කරන්න." }, { quoted: msg });
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

            // 🚨 STATUS COMMAND (Admin Only)
            if (textLower === 'status') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const statusMsg = `✅ *HansanaBot Status*\n\n👥 *Used Requests:* ${geminiRequestsToday}/500\n📁 *Total Files:* ${fileRegistry.length}\n📚 *Saved Info:* ${knowledgeBase.length}\n👥 *Registered Students:* ${studentRegistry.length}`;
                await sock.sendMessage(sender, { text: statusMsg }, { quoted: msg });
                return;
            }

            // 🚨 ADD INFO (Admin)
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

            // 🤖 AI Intent
            const aiIntent = await getCalendarIntentFromAI(rawMessageText);
            
            if (aiIntent.intent === 'calendar') {
                const { start, end, targetDate } = getTargetDateRange(aiIntent.date_keyword || textLower);
                const events = await getCalendarEvents(start, end);

                if (events && events.length > 0) {
                    let msgText = `📅 *${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })} දින Classes:*\n\n`;
                    events.forEach((ev, idx) => {
                        const startTime = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute:'2-digit' });
                        const endTime = new Date(ev.end?.dateTime || ev.end?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute:'2-digit' });
                        const location = ev.location || '';
                        const description = ev.description || '';
                        
                        msgText += `${idx+1}. *${ev.summary || 'Untitled'}*\n`;
                        msgText += `   🕒 ${startTime} – ${endTime}\n`;
                        if (location) msgText += `   📍 *ස්ථානය (Location):* ${location}\n`;
                        if (description) msgText += `   📝 *විස්තරය (Details):* ${cleanHTML(description)}\n`;
                        msgText += `\n`;
                    });
                    msgText += `\n🔗 *Full Calendar:* https://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(CALENDAR_ID)}`;
                    await sock.sendMessage(sender, { text: msgText }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, { text: `🎉 *${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })}* දිනට Classes නෑ!` }, { quoted: msg });
                }
                return;
            }
            
            if (aiIntent.intent === 'add_info' && isSenderAdmin(sender)) {
                const infoText = rawMessageText.replace(/^(add info|info add|save info)\s*:?\s*/i, '').trim();
                if (infoText) {
                    knowledgeBase.push(infoText);
                    saveKnowledgeBase();
                    await sock.sendMessage(sender, { text: `✅ Info saved! (Total: ${knowledgeBase.length})` }, { quoted: msg });
                    return;
                }
            }

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

            // ---------- GEN Z GUIDE (නවතම එකතු කිරීම) ----------
            if (textLower === 'guide' || textLower === 'genz' || textLower === 'how to use') {
                const genZGuide = `Yo bestie! 👋🔥 I'm *HansanaBot*, your AI slay assistant! No cap, I got your back! 🫡✨

🛠️ *How to use me (fr fr):*
👉 Just type *"ada class"* or *"heta class"* to see what's poppin' today/tomorrow.
👉 Type *"quiz"* to test your brain before the lecture! (Don't be a procrastinator, bestie! 😤)
👉 Need notes? Type *"pdf"* to get the actual file!
👉 Got a random question? Just ask me in Sinhala or English.
👉 *"status"* is only for the main character (Admin) 💅

Catch my drift? Slide into my DMs and let's get that GPA up! 📈🚀`;
                await sock.sendMessage(sender, { text: genZGuide }, { quoted: msg });
                return;
            }

            // ---------- HELP MENU (Student & Admin) ----------
            if (textLower === 'help' || textLower === '/help' || textLower === 'menu' || textLower === '/menu' || textLower === 'start' || textLower === '/start' || textLower === 'commands' || textLower === 'hi' || textLower === 'hello' || textLower === 'hey' || textLower === 'hii' || textLower === 'hlo' || textLower === 'hi there' || textLower === 'good morning' || textLower === 'good night' || textLower === 'suba') {
                const isAdmin = isSenderAdmin(sender);
                let helpText = `👋 *HansanaBot Help Menu* 🤖

*General Commands:*
📌 *guide* - Gen Z Style Guide එක බලන්න
🆔 *whoami* - ඔයාගේ ID එක බලන්න
👤 *who am i* - Adminද Studentද කියලා බලන්න
📅 *calendar* - අද / හෙට / ඉදිරි දවස් වල Classes බලන්න
📂 *pdf* - Save කරලා තියෙන Files ලබා ගන්න

*📞 Support:*
Contact Batch Rep: +94 76 251 3957`;

                if (isAdmin) {
                    helpText += `

*🛠️ Admin Commands (Only for Batch Rep):*
📝 *add info: [text]* - අලුත් තොරතුරු save කරන්න
📚 *list info* - Save කරලා තියෙන Info ටික බලන්න
🗑️ *remove info [number]* - Info එකක් අයින් කරන්න
📤 *add file: [keyword]* - PDF/Image එකක් save කරන්න
📋 *list files* - Save කරලා තියෙන Files ටික බලන්න
🗑️ *remove file [number]* - File එකක් අයින් කරන්න
📊 *status* - Bot එකේ තත්වය බලන්න`;
                }
                
                await sock.sendMessage(sender, { text: helpText }, { quoted: msg });
                return;
            }

            // WHOAMI ID
            if (textLower === 'whoami' || textLower === 'myid') {
                const normalized = jidNormalizedUser(sender) || sender;
                await sock.sendMessage(sender, { text: `🆔 Your ID: \`${normalized}\`` }, { quoted: msg });
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

            // ==========================================================
            // 🚨 FILE DELIVERY (STRICT) - "pdf", "evidence", "file" ඉල්ලුවම විතරයි
            // ==========================================================
            const matchedFile = fileRegistry.find(f => {
                const kwWords = f.keyword.toLowerCase().split(/[\s,:.!?()]+/).filter(w => w.length > 2);
                return textLower.includes(kw) || kwWords.some(word => textLower.includes(word));
            });

            if (matchedFile && (textLower === 'pdf' || textLower.includes('pdf') || textLower.includes('evidence') || textLower.includes('source') || textLower.includes('file'))) {
                try {
                    const filePath = path.join(FILES_DIR, matchedFile.storedFileName);
                    if (fs.existsSync(filePath)) {
                        const buffer = fs.readFileSync(filePath);
                        await sock.sendMessage(sender, { 
                            document: buffer, 
                            mimetype: matchedFile.mimetype || 'application/pdf', 
                            fileName: matchedFile.fileName || 'document.pdf' 
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: "❌ File එක නෑ. Bot එක Restart වෙලා නම් Admin ට කියලා ආයේ Add කරන්න." }, { quoted: msg });
                    }
                } catch (err) {
                    console.error('❌ Error sending file:', err);
                    await sock.sendMessage(sender, { text: "❌ File එක යවන්න අවුලක් වුණා. නැවත try කරන්න." }, { quoted: msg });
                }
                return;
            }
            // ==========================================================

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

            // ---------- SMART QUIZ GENERATOR ----------
            if (textLower.includes('quiz') || textLower.includes('test me') || textLower.includes('practice') || textLower === 'test') {
                const { start, end } = getTargetDateRange(textLower);
                const events = await getCalendarEvents(start, end);

                let moduleName = "General SLIIT IT Module";
                if (events && events.length > 0) {
                    moduleName = events[0].summary || "General SLIIT IT Module";
                }

                const matchedPDF = fileRegistry.find(f => 
                    f.mimetype === 'application/pdf' && 
                    new RegExp(`\\b${f.keyword}\\b`, 'i').test(textLower)
                );

                try {
                    if (matchedPDF) {
                        await sock.sendMessage(sender, { text: `📄 *${moduleName}* Quiz එක PDF *${matchedPDF.fileName}* එක මත පදනම්ව හදනවා... (ප්‍රශ්න 10යි)` }, { quoted: msg });

                        const pdfBuffer = fs.readFileSync(path.join(FILES_DIR, matchedPDF.storedFileName));
                        const base64Pdf = pdfBuffer.toString('base64');
                        const pdfPart = { inlineData: { data: base64Pdf, mimeType: 'application/pdf' } };

                        const pdfQuizPrompt = `You are a strict but friendly tutor. 
Generate a 10-question quiz based *ONLY* on the content of the provided PDF file. 
The module is "${moduleName}".
Rules:
1. Ask the questions ONE BY ONE (wait for the student's answer before asking the next).
2. After the student answers, tell them if they are correct or incorrect.
3. If the student says "I don't know" or "bari", explain the concept clearly before moving to the next question.
4. At the end, give them a final score.`;

                        geminiRequestsToday++;
                        const pdfResult = await model.generateContent([pdfQuizPrompt, pdfPart]);
                        const pdfReply = formatMathForWhatsApp(pdfResult.response.text());
                        await sock.sendMessage(sender, { text: pdfReply }, { quoted: msg });

                    } else {
                        await sock.sendMessage(sender, { text: `📝 ඔයාගේ *${moduleName}* Quiz එක Knowledge Base එකෙන් පටන් ගන්නවා! (ප්‍රශ්න 10යි)` }, { quoted: msg });

                        const quizPrompt = `You are a strict but friendly tutor. 
Generate a 10-question quiz specifically for the module "${moduleName}" based on the knowledge base provided below.
Rules:
1. Ask the questions ONE BY ONE (wait for the student's answer before asking the next).
2. After the student answers, tell them if they are correct or incorrect.
3. If the student says "I don't know" or "bari", explain the concept clearly before moving to the next question.
4. At the end of the 10 questions, give them a final score.

Knowledge Base:
${JSON.stringify(knowledgeBase)}`;

                        geminiRequestsToday++;
                        const result = await model.generateContent(quizPrompt);
                        const reply = formatMathForWhatsApp(result.response.text());
                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                    }
                } catch (error) {
                    console.error('Quiz error:', error);
                    await sock.sendMessage(sender, { text: "❌ Quiz generate කරන්න බැරි වුණා. ටිකකින් ආයේ try කරන්න." }, { quoted: msg });
                }
                return;
            }

            // ---------- AI FILE QUERY (Stored PDF කියවලා ප්‍රශ්නයට උත්තර දීම) ----------
            const isExplicitFileRequest2 = /\b(pdf|file|send|download|document|danna|ewanna|yawanna|evidence|source|uththara|sadaha|reference|prove|copy)\b/i.test(textLower);
            
            if (!isExplicitFileRequest2) {
                const matchedFileContext = fileRegistry.find(f => {
                    const kw = f.keyword.toLowerCase();
                    return kw.split(/[\s,:.!?()]+/).some(word => word.length > 2 && textLower.includes(word)) || textLower.includes(kw);
                });

                if (matchedFileContext && matchedFileContext.mimetype === 'application/pdf') {
                    try {
                        const filePath = path.join(FILES_DIR, matchedFileContext.storedFileName);
                        if (fs.existsSync(filePath)) {
                            const pdfBuffer = fs.readFileSync(filePath);
                            const base64Pdf = pdfBuffer.toString('base64');
                            const pdfPart = { inlineData: { data: base64Pdf, mimeType: 'application/pdf' } };

                            const queryPrompt = `Read the attached PDF file. The user has asked: "${rawMessageText}".\n\nAnswer the user's question directly, briefly, and clearly based ONLY on the information in the PDF file. If the answer is not in the PDF, say "Sorry, this information is not in the file." Do not mention the file name unless necessary.`;

                            geminiRequestsToday++;
                            const result = await model.generateContent([queryPrompt, pdfPart]);
                            const reply = formatMathForWhatsApp(result.response.text());

                            const userGuide = `\n\n📄 *ඔයාට මේ තොරතුරු වල සාක්ෂි (Evidence) බලන්න ඕනද?*\n👉 එතකොට *"pdf"* කියලා type කරන්න.`;

                            await sock.sendMessage(sender, { text: reply + userGuide }, { quoted: msg });
                            return;
                        }
                    } catch (error) {
                        console.error('AI File Query Error:', error);
                        await sock.sendMessage(sender, { text: "❌ File එක විවෘත කරන්න බැරි වුණා. ආයේ උත්සාහ කරන්න." }, { quoted: msg });
                    }
                }
            }

            // ---------- GENERAL AI RESPONSE (මතකය සමඟ) ----------
            if (rawMessageText) {
                try {
                    const history = getRecentContext(sender);
                    
                    let promptToSend = fullUserPrompt;
                    if (history) {
                        promptToSend = `පෙර සංවාදය:\n${history}\n\nවත්මන් ප්‍රශ්නය: ${fullUserPrompt}`;
                    }

                    geminiRequestsToday++;
                    const result = await model.generateContent(buildPromptWithKnowledge(promptToSend));
                    const reply = formatMathForWhatsApp(result.response.text());
                    
                    addToMemory(sender, 'User', fullUserPrompt);
                    addToMemory(sender, 'Bot', reply);

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
