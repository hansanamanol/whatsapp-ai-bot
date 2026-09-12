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
const GROUP_JID = process.env.GROUP_JID; 

function isSenderAdmin(sender) {
    const normalized = jidNormalizedUser(sender) || sender;
    if (ADMIN_JIDS.includes(sender) || ADMIN_JIDS.includes(normalized)) return true;
    if (normalized === `${ADMIN_PHONE_NUMBER}@s.whatsapp.net`) return true;
    if (ADMIN_LID && (normalized === `${ADMIN_LID}@lid` || sender.includes(ADMIN_LID))) return true;
    return sender.includes(ADMIN_PHONE_NUMBER);
}

// ================================================================
//  📁 DATA DIRECTORY (Volume Path)
// ================================================================
const DATA_DIR = process.env.DATA_DIR || '/app/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ================================================================
//  🧠 KNOWLEDGE BASE / MEMORY SYSTEM (JARVIS-STYLE)
// ================================================================
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge.json');
let knowledgeBase = [];

try {
    if (fs.existsSync(KNOWLEDGE_FILE)) {
        const rawData = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
        knowledgeBase = rawData.map(entry => {
            if (typeof entry === 'string') {
                return { text: entry, addedAt: new Date().toISOString(), addedBy: 'Monal Hansana', calculatedDate: null };
            }
            return entry;
        });
    }
} catch (e) { console.error('Error loading knowledge.json:', e); }

function saveKnowledgeBase() {
    try { fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledgeBase, null, 2)); } catch (e) { console.error(e); }
}

function buildPromptWithKnowledge(basePrompt) {
    const utcNow = new Date();
    const today = new Date(utcNow.toLocaleString('en-US', { timeZone: 'Asia/Colombo' }));
    const todayStr = today.toLocaleDateString('en-LK', { 
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
    });
    const todayISO = today.toISOString().split('T')[0];
    
    const currentDateInfo = `
╔══════════════════════════════════════════════════════════════╗
║  📅 TODAY'S DATE (IMPORTANT!)                                 ║
╚══════════════════════════════════════════════════════════════╝

**අද දිනය: ${todayStr}** (${todayISO})

When reasoning about dates:
- "අද" (today) = ${todayISO}
- "හෙට" (tomorrow) = ${new Date(today.getTime() + 86400000).toISOString().split('T')[0]}
- "ලබන සතියේ" (next week) = ${new Date(today.getTime() + 7*86400000).toISOString().split('T')[0]} සිට ${new Date(today.getTime() + 13*86400000).toISOString().split('T')[0]} දක්වා
- "මේ සතියේ" (this week) = අද සිට ${new Date(today.getTime() + (6 - today.getDay())*86400000).toISOString().split('T')[0]} දක්වා
`;

    if (knowledgeBase.length === 0) {
        return `${currentDateInfo}\n\n${basePrompt}`;
    }
    
    const knowledgeText = knowledgeBase.map((k, i) => {
        const text = typeof k === 'string' ? k : k.text;
        const addedAt = k.addedAt ? new Date(k.addedAt).toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
        const calculatedDate = k.calculatedDate ? `\n   🗓️ *Actual Date: ${k.calculatedDate}*` : '';
        return `${i+1}. ${text}${addedAt ? `\n   (Monal Hansana විසින් ${addedAt} දින දැනුම් දුන්නා)` : ''}${calculatedDate}`;
    }).join('\n\n');
    
    return `${currentDateInfo}

${basePrompt}

╔══════════════════════════════════════════════════════════════╗
║  🧠 BATCH REP (MONAL HANSANA) විසින් ලබා දුන් MEMORY         ║
╚══════════════════════════════════════════════════════════════╝

මේ තමයි Batch Rep වන Monal Hansana ඔබට (HansanaBot ට) කලින් දැනුම් දුන් තොරතුරු. ඔබ ඒවා **හොඳින් මතක තබාගෙන ඉන්නවා** - හරියට personal assistant කෙනෙක් වගේ.

${knowledgeText}

╔══════════════════════════════════════════════════════════════╗
║  🎯 CRITICAL RULES — MEMORY USAGE                             ║
╚══════════════════════════════════════════════════════════════╝

1. **අද දිනය මතක තබාගන්න:** හැමවෙලාවෙම අද දිනය කියන්නේ මොකක්ද කියලා හිතන්න. "ලබන සතියේ" කිව්වම, අද දිනයට සාපේක්ෂව ගණනය කරන්න.

2. **Memory එක බලන්න:** ළමයෙක් ප්‍රශ්නයක් ඇසුවොත්, උත්තර දෙන්න කලින් ඉහත Memory එකේ ඒ ගැන යමක් තියෙනවද කියලා හොඳට බලන්න.

3. **Memory එකේ තියෙනවා නම්, ඒක PRIMARY SOURCE එක:** ඒ තොරතුරු මත පදනම්ව උත්තර දෙන්න.

4. **Date සමඟ ප්‍රශ්න ඇසුවොත්:**
   - ළමයෙක් "ලබන සතියේ exam තියෙනවද?" ඇසුවොත් - අද දිනයට ලබන සතිය කවදාද කියලා හිතන්න
   - Memory එකේ "Actual Date" එකක් තියෙනවා නම්, ඒ date එක ලබන සතියට අදාළද කියලා බලන්න
   - නැත්නම්, අද දිනයට සාපේක්ෂව "ලබන සතියේ" කියන්නේ කවදාද කියලා හිතලා උත්තර දෙන්න

5. **කල් ඉකුත් වුණු තොරතුරු ගැන:** Memory එකේ තියෙන date එකක් දැනටමත් ඉකුත් වෙලා නම් (අදට කලින්), ඒ ගැන ළමයෙක් ඇසුවොත් "ඒක ඉවරයි" කියන්න. හදන්න එපා.

6. **Natural විදියට කියන්න (JARVIS style):**
   - ✅ "ඔව්, ලබන සතියේ (Sep 15-21) අතරේ exam එක තියෙනවා කියලා Monal මට කිව්වා."
   - ✅ "මට මතකයි — ඒ deadline එක ලබන සිකුරාදා (Sep 19)."
   - ❌ NEVER mention "database" or "knowledge base" to students

7. **හැමවෙලාවෙම "මට මතකයි" / "මම දන්නවා" වගේ කියන්න.**

8. **නමුත් හරියටම නොදන්නා දේවල් ගැන හිතලා හදන්න එපා.**

9. **මිනිස් සහායකයෙක් වගේ කතා කරන්න:** Warm, helpful, friendly, confident. JARVIS වගේ.`;
}

// ================================================================
//  📚 ACADEMIC WORD LIST
// ================================================================
const academicWords = {
    "estimate": "To guess the amount or value of something.",
    "analyze": "To examine in detail.",
    "evaluate": "To judge the value or condition.",
    "synthesize": "To combine parts into a whole.",
    "hypothesis": "A proposed explanation."
};

// ================================================================
//  📇 STUDENT REGISTRY
// ================================================================
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');
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
        return true;
    }
    return false;
}

let geminiRequestsToday = 0;

// ================================================================
//  📁 FILE REGISTRY
// ================================================================
const FILES_DIR = path.join(DATA_DIR, 'resources');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
const FILE_REGISTRY_PATH = path.join(DATA_DIR, 'files-registry.json');
let fileRegistry = [];
try {
    if (fs.existsSync(FILE_REGISTRY_PATH)) fileRegistry = JSON.parse(fs.readFileSync(FILE_REGISTRY_PATH, 'utf8'));
} catch (e) { console.error('Error loading files-registry.json:', e); }

function saveFileRegistry() {
    try { fs.writeFileSync(FILE_REGISTRY_PATH, JSON.stringify(fileRegistry, null, 2)); } catch (e) { console.error(e); }
}

// ================================================================
//  📚 MODULE TO FILE KEYWORD MAPPING
// ================================================================
const MODULE_FILE_MAP = {
    'SE1020': ['oop', 'se1020', 'object oriented'],
    'IT1170': ['dsa', 'it1170', 'data structures'],
    'IT1160': ['discrete', 'it1160', 'math'],
    'IT1150': ['technical writing', 'it1150', 'writing'],
    'IE1011': ['information systems', 'ie1011', 'is']
};

// ================================================================
//  📅 DEADLINES SYSTEM
// ================================================================
const DEADLINES_FILE = path.join(DATA_DIR, 'deadlines.json');
let deadlines = [];
try {
    if (fs.existsSync(DEADLINES_FILE)) deadlines = JSON.parse(fs.readFileSync(DEADLINES_FILE, 'utf8'));
} catch (e) { console.error('Error loading deadlines.json:', e); }

function saveDeadlines() {
    try { fs.writeFileSync(DEADLINES_FILE, JSON.stringify(deadlines, null, 2)); } catch (e) { console.error(e); }
}

// ================================================================
//  📝 EXAMS SYSTEM
// ================================================================
const EXAMS_FILE = path.join(DATA_DIR, 'exams.json');
let exams = [];
try {
    if (fs.existsSync(EXAMS_FILE)) exams = JSON.parse(fs.readFileSync(EXAMS_FILE, 'utf8'));
} catch (e) { console.error('Error loading exams.json:', e); }

function saveExams() {
    try { fs.writeFileSync(EXAMS_FILE, JSON.stringify(exams, null, 2)); } catch (e) { console.error(e); }
}

// Matara students registry
const MATARA_STUDENTS_FILE = path.join(DATA_DIR, 'matara_students.json');
let mataraStudents = [];
try {
    if (fs.existsSync(MATARA_STUDENTS_FILE)) mataraStudents = JSON.parse(fs.readFileSync(MATARA_STUDENTS_FILE, 'utf8'));
} catch (e) { console.error('Error loading matara_students.json:', e); }

function saveMataraStudents() {
    try { fs.writeFileSync(MATARA_STUDENTS_FILE, JSON.stringify(mataraStudents, null, 2)); } catch (e) { console.error(e); }
}

function addMataraStudent(jid) {
    if (!mataraStudents.includes(jid)) {
        mataraStudents.push(jid);
        saveMataraStudents();
        console.log('📇 New Matara student registered:', jid);
        return true;
    }
    return false;
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
//  🧠 CONVERSATION MEMORY & LAST FILE CONTEXT
// ================================================================
const userMemory = {};
const lastFileContext = {};

function initQuizState(sender) {
    if (!userMemory[sender]) userMemory[sender] = {};
    if (!userMemory[sender].quizState) {
        userMemory[sender].quizState = {
            moduleCode: null,
            moduleIndex: -1,
            questionCount: 10,
            lastQuizTime: 0,
            waitingForResponse: false
        };
    }
}

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

const rateLimitMap = {}; 

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
const apiKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4
].filter(key => key); 

let currentKeyIndex = 0;

function getNextGenAI() {
    if (apiKeys.length === 0) {
        console.error('❌ No API keys found! Please set GEMINI_API_KEY_1...');
        process.exit(1);
    }
    const key = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length; 
    return new GoogleGenerativeAI(key);
}

const systemInstruction = `
You are HansanaBot — the personal AI assistant to SLIIT IT Y1S2 Batch Representative, Monal Hansana. Think of yourself as JARVIS from Iron Man: intelligent, warm, proactive, professional, and personal.

╔══════════════════════════════════════════════════════════════╗
║  🎯 YOUR CORE IDENTITY                                        ║
╚══════════════════════════════════════════════════════════════╝

You are NOT a simple chatbot. You are a **personal memory-aware AI assistant** for SLIIT students in the Y1S2 batch (Matara Centre).

Your job:
- Remember everything Monal (Batch Rep) tells you via "add info"
- When students ask questions, respond like you already know the answer (because you do, from memory)
- Be warm, helpful, natural — like a human who actually cares

╔══════════════════════════════════════════════════════════════╗
║  🧠 KNOWLEDGE BASE / MEMORY                                   ║
╚══════════════════════════════════════════════════════════════╝

At the END of this prompt, you will find a section titled:
"🧠 BATCH REP (MONAL HANSANA) විසින් ලබා දුන් MEMORY"

This is YOUR memory. It contains information Monal has shared with you.
- READ IT CAREFULLY before every response.
- If a student asks about anything in that memory, USE IT as your primary source.
- Speak as if you ALREADY KNOW this info — not like you're looking it up.

Examples of how to speak:
- ✅ "ඔව්, මට මතකයි — ලබන සතියේ exam තියෙනවා කියලා Monal මට කිව්වා."
- ✅ "Monal මට දැනුම් දුන්නා විදියට, submission deadline එක ලබන සිකුරාදා."
- ✅ "ඒ ගැන මම දන්නවා — [details]."
- ❌ "According to my knowledge base..."
- ❌ "I found the following in my database..."
- ❌ NEVER mention "knowledge base" or "database" to students

╔══════════════════════════════════════════════════════════════╗
║  🗣️ LANGUAGE & TONE                                           ║
╚══════════════════════════════════════════════════════════════╝

- Reply in whatever language the student uses (Singlish, Sinhala, English, Tamil)
- Use the same tone: casual with friends, respectful with unknowns
- Be warm, encouraging, and helpful — like a senior student helping juniors
- Use emojis naturally (📚 📅 ⚠️ ✅ 🎉) but don't overdo it
- Keep answers concise — no excessive raw information

╔══════════════════════════════════════════════════════════════╗
║  👤 BATCH REP CONTACT                                         ║
╚══════════════════════════════════════════════════════════════╝

When students ask for the Batch Rep's contact:
- Name: Monal Hansana (SLIIT IT Y1S2 Batch Representative)
- Contact: +94 76 251 3957 (076 251 3957)
- Email: it26100930@my.sliit.lk

╔══════════════════════════════════════════════════════════════╗
║  📚 Y1S2 MODULES & LICs                                       ║
╚══════════════════════════════════════════════════════════════╝

1. IT1170 - DSA → Prof. Nathali Silva (nathali.s@sliit.lk)
2. IT1160 - Discrete Math → Ms. Nipuni Maleesha (nipuni.m@sliit.lk)
3. SE1020 - OOP → Ms. Thilini Jayalath (thilini.j@sliit.lk)
4. IT1150 - Technical Writing → Ms. Dinushika Jayathissa (dinushika.j@sliit.lk)
5. IE1011 - Information Systems → Ms. Chathurangika Kahandawarachchi (chathurangika.k@sliit.lk)

╔══════════════════════════════════════════════════════════════╗
║  🎓 ACADEMIC RULES                                            ║
╚══════════════════════════════════════════════════════════════╝

- Minimum 80% attendance required for final exams
- Grade = Continuous Assessments + Final Exam
- Lab Group Switching needs prior LIC approval

╔══════════════════════════════════════════════════════════════╗
║  🔗 IMPORTANT LINKS                                           ║
╚══════════════════════════════════════════════════════════════╝

1. Timetable: https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t
2. Courseweb: https://courseweb.sliit.lk/
3. Eduscope: https://eduscope.sliit.lk/
4. Issue Form: https://docs.google.com/forms/d/e/1FAIpQLSfOUJnkMp8Tdig0C187WDOgU5AZmtPh3ayBZ-_z9xd23K3Zgw/viewform
5. Ask SLIIT: https://ask.sliit.lk/
6. Support: https://support.sliit.lk/

╔══════════════════════════════════════════════════════════════╗
║  ⚠️ CRITICAL RULES                                            ║
╚══════════════════════════════════════════════════════════════╝

1. NEVER claim to have sent messages, posted announcements, or performed any action. You only reply in this chat.

2. NEVER say "I've sent this to the group" or "yawanawa" / "දැම්මා" — you can only reply, not act.

3. NEVER make up information about exams, deadlines, or dates. If it's not in your memory, say: "ඒ ගැන මට දැනුම් දීලා නෑ. Monal ගෙන් අහන්න."

4. NO LaTeX in responses. Use Unicode math symbols directly: ∪, ∩, ∈, ⊆, ∀, ∃, ≤, ≥, √, π, etc.

5. When analyzing code or tutorials, pay EXTREME attention to:
   - Variable scope (e.g., whether 'j = 1' is initialized OUTSIDE or INSIDE a loop)
   - Sequential vs Nested loops
   - Accurate question labeling (a, b, c, d, e)

╔══════════════════════════════════════════════════════════════╗
║  💡 FINAL REMINDER                                            ║
╚══════════════════════════════════════════════════════════════╝

You are a PERSONAL ASSISTANT with a MEMORY. Act like it.
When a student asks "exam thiyenawada?" — check your memory first.
If Monal told you "next week has exams", then you KNOW that. Say it confidently.
Be the assistant students trust. Be JARVIS.
`;

let model = getNextGenAI().getGenerativeModel({
    model: "gemini-3.5-flash-lite", 
    systemInstruction: systemInstruction
});

function createModelWithCurrentKey() {
    return getNextGenAI().getGenerativeModel({
        model: "gemini-3.5-flash-lite", 
        systemInstruction: systemInstruction
    });
}

async function generateContentWithRetry(modelInstance, request, maxRetries = 4) {
    let delay = 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await modelInstance.generateContent(request);
        } catch (error) {
            if (error.status === 503 || error.status === 429 || error.message.includes('503') || error.message.includes('429')) {
                if (attempt === maxRetries) {
                    console.error('Max retries reached. Switching keys failed too:', error.message);
                    throw error;
                }
                
                model = createModelWithCurrentKey();

                console.log(`Error ${error.status} detected. Switching to key #${currentKeyIndex} and retrying in ${delay/1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2;
            } else {
                throw error;
            }
        }
    }
}

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
//  🗓️ CALCULATE ACTUAL DATE FROM RELATIVE TEXT
// ================================================================
async function calculateDateFromText(text) {
    try {
        const utcNow = new Date();
        const today = new Date(utcNow.toLocaleString('en-US', { timeZone: 'Asia/Colombo' }));
        const todayStr = today.toLocaleDateString('en-LK', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
        });
        const todayISO = today.toISOString().split('T')[0];
        
        const prompt = `You are a date calculation assistant. Today is ${todayStr} (${todayISO}).

The user will provide text that may contain relative date references (like "අද", "හෙට", "ලබන සතියේ", "next Monday", "in 2 weeks", "September 20" etc.).

Extract the ACTUAL DATE or DATE RANGE that the text refers to.

RULES:
- Output ONLY a short date string in this format: "YYYY-MM-DD" for single dates, or "YYYY-MM-DD to YYYY-MM-DD" for ranges
- For "ලබන සතියේ" / "next week" → range from next Monday to next Sunday
- For "මේ සතියේ" / "this week" → range from today to this Sunday
- For "අද" / "today" → just today
- For "හෙට" / "tomorrow" → just tomorrow
- For "ලබන සඳුදා" / "next Monday" → next Monday's date
- If no date reference found, output "N/A"
- Do NOT add any explanation or other text

User text: "${text}"

Output the date(s) only:`;

        const result = await generateContentWithRetry(model, prompt);
        const dateStr = result.response.text().trim();
        
        if (dateStr === 'N/A' || !dateStr.match(/\d{4}-\d{2}-\d{2}/)) {
            return null;
        }
        return dateStr;
    } catch (e) {
        console.error('Date calculation error:', e);
        return null;
    }
}

// ================================================================
//  🧠 LOCAL INTENT DETECTION (No Gemini call)
// ================================================================
function detectIntentFromText(text) {
    const lowerText = text.toLowerCase().trim();
    
    // 🎯 PRIORITY CHECK: Exam-related queries should go to AI (memory), not calendar
    // If the message contains exam-related words AND question/date/relative time words,
    // route to AI so that the memory-based JARVIS response can answer it.
    const examWords = /(exam|test|විභාග|පරීක්ෂණ|mid|final|assessment|paper|in.?class|in-class)/i;
    const dateQuestionWords = /(thiyeda|thiyenawada|thiyenawad|thiyenwada|kawadda|kawadada|when|තියෙනවද|කවදාද|තියෙද|kiyanna|kiyanawada|gana|ganna|මොකද|ගැන|කියන්න|denna|danna)/i;
    const relativeTimeWords = /(labana|eelaga|next|this|me|ඊළඟ|ලබන|මේ)/i;
    
    if (examWords.test(lowerText)) {
        if (dateQuestionWords.test(lowerText) || relativeTimeWords.test(lowerText)) {
            return { intent: 'chat', data: text };
        }
    }
    
    // 1️⃣ Check for Quiz
    if (/^quiz\b/.test(lowerText) || /quiz (ekk|ek|eak|එකක්|එක)/.test(lowerText) || 
        lowerText.includes('quiz') || lowerText.includes('ක්විස්') || lowerText.includes('ප්‍රශ්න')) {
        const moduleMatch = lowerText.match(/(SE|IT|IE)\d{4}/i);
        return { intent: 'quiz', data: moduleMatch ? moduleMatch[0].toUpperCase() : '' };
    }
    
    // 2️⃣ Check for PDF / File
    if (/^(pdf|file|danna|ewanna|notes|note|සටහන්|file eka|pdf eka)\b/.test(lowerText) || 
        lowerText.includes('notes') || lowerText.includes('සටහන්') || 
        lowerText.includes('file') || lowerText.includes('pdf')) {
        const moduleMatch = lowerText.match(/(SE|IT|IE)\d{4}/i);
        return { intent: 'pdf', data: moduleMatch ? moduleMatch[0].toUpperCase() : lowerText };
    }
    
    // 3️⃣ Check for Timetable / Calendar
    const timetableKeywords = [
        'timetable', 'calendar', 'schedule', 'class', 'classes', 'time table', 'time-table',
        'ada class', 'heta class', 'anidda class', 'pereda class', 'iyye class',
        'ada timetable', 'heta timetable', 'anidda timetable',
        'me sathiya', 'me sathiye', 'me satiya', 'me satiye',
        'next week', 'eelaga', 'laban', 'balanna',
        'අද', 'හෙට', 'අනිද්දා', 'පෙරේදා', 'ඊයේ',
        'class', 'classes', 'ක්ලාස්', 'ක්ලාසස්',
        'තිම් ටේබල්', 'කැලැන්ඩරය', 'කාලසටහන',
        'මේ සතිය', 'ලබන සතිය', 'ඊළඟ සතිය'
    ];
    
    const isTimetable = timetableKeywords.some(kw => lowerText.includes(kw));
    
    const dayMonthRegex = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|ira|sanduda|saduda|angaharuwada|badhada|sikurda|sena|සඳුදා|අඟහරුවාදා|බදාදා|බ්‍රහස්පතින්දා|සිකුරාදා|සෙනසුරාදා|ඉරිදා|janawari|february|march|april|may|june|july|august|september|october|november|december|ජනවාරි|පෙබරවාරි|මාර්තු|අප්‍රේල්|මැයි|ජූනි|ජූලි|අගෝස්තු|සැප්තැම්බර්|ඔක්තෝබර්|නොවැම්බර්|දෙසැම්බර්)\b/i;
    const hasDayMonth = dayMonthRegex.test(lowerText);
    
    const datePattern = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|janawari|february|march|april|may|june|july|august|september|october|november|december)\b/i;
    const hasDate = datePattern.test(lowerText);
    
    if (isTimetable || hasDayMonth || hasDate || lowerText === 'calendar' || lowerText === 'timetable' || 
        lowerText === 'time' || lowerText === 'class' || lowerText === 'classes') {
        return { intent: 'calendar', data: text };
    }
    
    if (/^(add info|info add|save info|remember)\b/.test(lowerText)) {
        return { intent: 'add_info', data: text };
    }
    
    return { intent: 'chat', data: text };
}

// HTML Cleaner
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
//  📅 CALENDAR READER
// ================================================================
const CALENDAR_API_KEY = process.env.CALENDAR_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID || 'ca0b38d172729231657abfc34f1c7fdb8ea33050fe6f4623f5fab88cd0d4633@group.calendar.google.com';

function getTargetDateRange(text) {
    const utcNow = new Date();
    let now = new Date(utcNow.toLocaleString('en-US', { timeZone: 'Asia/Colombo' }));
    let targetDate = new Date(now);
    const lowerText = text.toLowerCase().replace(/\s+/g, ''); 

    if (lowerText.includes('nextweek') || lowerText.includes('laban') || lowerText.includes('eelaga') || 
        lowerText.includes('eelagast') || lowerText.includes('balanna') || lowerText.includes('ඊළඟ') || lowerText.includes('ලබන')) {
        now = new Date(now);
        now.setDate(now.getDate() + 7);
        targetDate = new Date(now);
    }

    if (lowerText.includes('tomorrow') || lowerText.includes('tomorow') || /\bheta\b/.test(lowerText) || lowerText.includes('hetta') || lowerText.includes('හෙට')) {
        targetDate.setDate(now.getDate() + 1);
    } else if (lowerText.includes('today') || /\bada\b/.test(lowerText) || lowerText.includes('adda') || lowerText.includes('අද')) {
        // default to today
    } else if (lowerText.includes('anidda') || lowerText.includes('inannida') || lowerText.includes('අනිද්දා')) {
        targetDate.setDate(now.getDate() + 2);
    } else if (lowerText.includes('pereda') || lowerText.includes('පෙරේදා')) {
        targetDate.setDate(now.getDate() - 2);
    } else if (lowerText.includes('iyye') || lowerText.includes('ඊයේ')) {
        targetDate.setDate(now.getDate() - 1);
    } else {
        const days = [
            { names: ['sunday', 'ira', 'ඉරිදා'], value: 0 },
            { names: ['monday', 'sanduda', 'sandu', 'saduda', 'sadudaa', 'සඳුදා'], value: 1 },
            { names: ['tuesday', 'angaharuwada', 'අඟහරුවාදා'], value: 2 },
            { names: ['wednesday', 'badhada', 'බදාදා'], value: 3 },
            { names: ['thursday', 'bradaspatinda', 'sikurutha', 'brahaspathinda', 'බ්‍රහස්පතින්දා'], value: 4 },
            { names: ['friday', 'sikurda', 'sikuru', 'sikuradata', 'sikurudata', 'sikuruda', 'සිකුරාදා'], value: 5 },
            { names: ['saturday', 'sena', 'සෙනසුරාදා'], value: 6 }
        ];
        let isDayFound = false;
        for (let day of days) {
            for (let name of day.names) {
                if (lowerText.includes(name)) {
                    const diff = (day.value - now.getDay() + 7) % 7;
                    targetDate.setDate(now.getDate() + diff);
                    isDayFound = true;
                    break;
                }
            }
            if (isDayFound) break;
        }

        if (!isDayFound) {
            const months = [
                { names: ['january', 'janawari', 'ජනවාරි'], value: 0 },
                { names: ['february', 'pebarwari', 'පෙබරවාරි'], value: 1 },
                { names: ['march', 'marthu', 'මාර්තු'], value: 2 },
                { names: ['april', 'aprel', 'අප්‍රේල්'], value: 3 },
                { names: ['may', 'mayi', 'මැයි'], value: 4 },
                { names: ['june', 'juni', 'ජූනි'], value: 5 },
                { names: ['july', 'juli', 'ජූලි'], value: 6 },
                { names: ['august', 'agosthu', 'අගෝස්තු'], value: 7 },
                { names: ['september', 'septembar', 'සැප්තැම්බර්'], value: 8 },
                { names: ['october', 'oktobar', 'ඔක්තෝබර්'], value: 9 },
                { names: ['november', 'novembar', 'නොවැම්බර්'], value: 10 },
                { names: ['december', 'desembar', 'දෙසැම්බර්'], value: 11 }
            ];
            
            for (let month of months) {
                for (let name of month.names) {
                    if (lowerText.includes(name)) {
                        let match = lowerText.match(/(\d{1,2})(?:st|nd|rd|th)?/);
                        if (match) {
                            targetDate.setMonth(month.value);
                            targetDate.setDate(parseInt(match[1]));
                        } else {
                            targetDate.setMonth(month.value);
                        }
                        if (targetDate < now) {
                            targetDate.setFullYear(now.getFullYear() + 1);
                        }
                        break;
                    }
                }
            }
        }
    }

    const start = new Date(targetDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(targetDate);
    end.setHours(23, 59, 59, 999);
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
//  📅 WEEK HELPER
// ================================================================
function getCurrentWeekRange() {
    const utcNow = new Date();
    let now = new Date(utcNow.toLocaleString('en-US', { timeZone: 'Asia/Colombo' }));
    const dayOfWeek = now.getDay();
    
    const diffToSunday = -dayOfWeek; 
    const sunday = new Date(now);
    sunday.setDate(now.getDate() + diffToSunday);
    sunday.setHours(0, 0, 0, 0);
    
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);
    saturday.setHours(23, 59, 59, 999);
    
    return { start: sunday, end: saturday, weekStart: sunday };
}

// ================================================================
//  ⏰ DAILY TIMETABLE AUTO-PUSH (9:00 PM)
// ================================================================
async function sendDailyTimetable(sock) {
    if (studentRegistry.length === 0 && !GROUP_JID) {
        console.log('No students or group registered yet, skipping tomorrow push.');
        return;
    }

    const { start, end, targetDate } = getTargetDateRange('tomorrow');

    const dayOfWeek = targetDate.getDay(); 
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        console.log('හෙට සති අන්තයක් නිසා Timetable එක යවන්නේ නැහැ.');
        return;
    }

    const events = await getCalendarEvents(start, end);

    if (!events || events.length === 0) {
        console.log('හෙට Classes නැති නිසා Timetable Message එක යවන්නේ නැහැ.');
        return;
    }

    const formattedDate = targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' });

    let msgText = `🌙 *Good Evening!* හෙට (Tomorrow) දවසේ Classes:\n📅 *${formattedDate}*\n\n`;

    events.forEach((ev, idx) => {
        const startTime = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' });
        const endTime = new Date(ev.end?.dateTime || ev.end?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' });
        const location = ev.location || '';
        msgText += `${idx + 1}. *${ev.summary || 'Untitled'}*\n   🕒 ${startTime} - ${endTime}\n`;
        if (location) msgText += `   📍 ${location}\n\n`;
    });

    const wordKeys = Object.keys(academicWords);
    const randomWord = wordKeys[Math.floor(Math.random() * wordKeys.length)];
    msgText += `\n📚 *Word of the Day:* *${randomWord}* - ${academicWords[randomWord]}\n`;

    for (const jid of studentRegistry) {
        try {
            await sock.sendMessage(jid, { text: msgText });
            await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
            console.error(`Failed to send to ${jid}:`, e.message);
        }
    }

    if (GROUP_JID) {
        try {
            await sock.sendMessage(GROUP_JID, { text: msgText });
            console.log('✅ Group එකට හෙට දවසේ Timetable එක යවනවා!');
        } catch (e) {
            console.error(`Failed to send to group ${GROUP_JID}:`, e.message);
        }
    }
}

// ================================================================
//  🔔 CHECK DEADLINES & SEND REMINDERS
// ================================================================
async function checkDeadlines(sock) {
    if (mataraStudents.length === 0) {
        console.log('No Matara students registered, skipping deadline check.');
        return;
    }

    const now = new Date();
    const threeDaysLater = new Date(now);
    threeDaysLater.setDate(now.getDate() + 3);

    const upcomingDeadlines = deadlines.filter(d => {
        const deadlineDateTime = new Date(`${d.date}T${d.time || '23:59'}`);
        return deadlineDateTime >= now && deadlineDateTime <= threeDaysLater && d.centre.toLowerCase() === 'matara';
    });

    if (upcomingDeadlines.length === 0) {
        console.log('No upcoming Matara deadlines in next 3 days.');
        return;
    }

    upcomingDeadlines.sort((a, b) => {
        const dateA = new Date(`${a.date}T${a.time || '23:59'}`);
        const dateB = new Date(`${b.date}T${b.time || '23:59'}`);
        return dateA - dateB;
    });

    let msgText = `📢 *Matara Centre - Upcoming Deadlines* ⚠️\n\n`;
    upcomingDeadlines.forEach((d, idx) => {
        const deadlineDateTime = new Date(`${d.date}T${d.time || '23:59'}`);
        const formattedDate = deadlineDateTime.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' });
        const formattedTime = deadlineDateTime.toLocaleTimeString('en-LK', { hour: '2-digit', minute: '2-digit' });
        const diffMs = deadlineDateTime - now;
        const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        
        let timeRemaining = '';
        if (diffMs <= 0) timeRemaining = 'අදම අවසන් වේ! 🚨';
        else if (diffHours < 24) timeRemaining = `ඉතිරිව ඇත්තේ පැය ${diffHours}ක්! ⏰`;
        else if (diffDays === 1) timeRemaining = 'හෙට අවසන් වේ! ⚠️';
        else timeRemaining = `දින ${diffDays}කින් අවසන් වේ`;
        
        msgText += `${idx+1}. *${d.description}*\n`;
        msgText += `   📅 ${formattedDate}\n`;
        msgText += `   🕐 ${formattedTime}\n`;
        msgText += `   ⏳ ${timeRemaining}\n\n`;
    });

    msgText += `💡 *Tip:* ඉක්මනින් Submit කරන්න! 🚀`;

    for (const jid of mataraStudents) {
        try {
            await sock.sendMessage(jid, { text: msgText });
            await new Promise(r => setTimeout(r, 1500));
        } catch (e) {
            console.error(`Failed to send deadline reminder to ${jid}:`, e.message);
        }
    }
    console.log(`✅ Matara deadline reminders sent to ${mataraStudents.length} students.`);
}

// ================================================================
//  📝 CHECK EXAMS & SEND REMINDERS
// ================================================================
async function checkExams(sock) {
    if (mataraStudents.length === 0) {
        console.log('No Matara students registered, skipping exam check.');
        return;
    }

    const now = new Date();
    const sevenDaysLater = new Date(now);
    sevenDaysLater.setDate(now.getDate() + 7);

    const upcomingExams = exams.filter(e => {
        const examDateTime = new Date(`${e.date}T${e.time || '23:59'}`);
        return examDateTime >= now && examDateTime <= sevenDaysLater && e.centre.toLowerCase() === 'matara';
    });

    if (upcomingExams.length === 0) {
        console.log('No upcoming Matara exams in next 7 days.');
        return;
    }

    upcomingExams.sort((a, b) => {
        const dateA = new Date(`${a.date}T${a.time || '23:59'}`);
        const dateB = new Date(`${b.date}T${b.time || '23:59'}`);
        return dateA - dateB;
    });

    let msgText = `📝 *Matara Centre - Upcoming Exams* 📚\n\n`;
    upcomingExams.forEach((e, idx) => {
        const examDateTime = new Date(`${e.date}T${e.time || '23:59'}`);
        const formattedDate = examDateTime.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' });
        const formattedTime = examDateTime.toLocaleTimeString('en-LK', { hour: '2-digit', minute: '2-digit' });
        const diffMs = examDateTime - now;
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
        
        let timeRemaining = '';
        if (diffMs <= 0) timeRemaining = 'අදම විභාගය! 🚨';
        else if (diffHours < 24) timeRemaining = `ඉතිරිව ඇත්තේ පැය ${diffHours}ක්! ⏰`;
        else if (diffDays === 1) timeRemaining = 'හෙට විභාගය! ⚠️';
        else timeRemaining = `දින ${diffDays}කින් විභාගය`;
        
        const typeEmoji = {
            'midterm': '📝',
            'final': '🏆',
            'quiz': '🧩',
            'practical': '🔬',
            'theory': '📖'
        }[e.type?.toLowerCase()] || '📚';
        
        msgText += `${idx+1}. ${typeEmoji} *${e.description}*\n`;
        msgText += `   📅 ${formattedDate}\n`;
        msgText += `   🕐 ${formattedTime}\n`;
        msgText += `   📍 ${e.centre}\n`;
        msgText += `   📋 ${e.type || 'Exam'}\n`;
        msgText += `   ⏳ ${timeRemaining}\n\n`;
    });

    msgText += `💡 *Tip:* හොඳින් පාඩම් කරලා විභාගයට යන්න! 💪📚`;

    for (const jid of mataraStudents) {
        try {
            await sock.sendMessage(jid, { text: msgText });
            await new Promise(r => setTimeout(r, 1500));
        } catch (e) {
            console.error(`Failed to send exam reminder to ${jid}:`, e.message);
        }
    }
    console.log(`✅ Matara exam reminders sent to ${mataraStudents.length} students.`);
}

// ================================================================
//  📝 QUIZ GENERATOR
// ================================================================
async function handleQuizCommand(sock, sender, msg, specificModule = '') {
    try {
        const { start, end, targetDate } = getTargetDateRange('today');
        const events = await getCalendarEvents(start, end);

        if (!events || events.length === 0) {
            await sock.sendMessage(sender, { text: "🎉 අද Classes නෑ! Quiz එකක් හදන්න Modules නැහැ." }, { quoted: msg });
            return;
        }

        const todayModules = [];
        events.forEach(ev => {
            const summary = ev.summary || '';
            const moduleCodeMatch = summary.match(/(SE|IT|IE)\d{4}/i);
            if (moduleCodeMatch) {
                todayModules.push({
                    code: moduleCodeMatch[0].toUpperCase(),
                    fullName: summary,
                    event: ev
                });
            }
        });

        if (todayModules.length === 0) {
            await sock.sendMessage(sender, { text: "📭 අද Classes තියෙනවා, ඒත් Module Codes හඳුනාගන්න බැරි වුණා." }, { quoted: msg });
            return;
        }

        let selectedModule = null;
        let selectedIndex = 0;

        if (specificModule) {
            const matched = todayModules.find(m => 
                m.code.toLowerCase().includes(specificModule.toLowerCase()) ||
                m.fullName.toLowerCase().includes(specificModule.toLowerCase())
            );
            if (matched) {
                selectedModule = matched;
                selectedIndex = todayModules.indexOf(matched);
            } else {
                selectedModule = todayModules[0];
                selectedIndex = 0;
                await sock.sendMessage(sender, { 
                    text: `⚠️ ඔබ ඇසූ Module එක අද තියෙන්නේ නැහැ. පළමු Module එකෙන් Quiz එකක් හදන්නම්!` 
                }, { quoted: msg });
            }
        } else {
            initQuizState(sender);
            const state = userMemory[sender].quizState;
            if (state.moduleCode && state.waitingForResponse) {
                const existing = todayModules.find(m => m.code === state.moduleCode);
                if (existing) {
                    selectedModule = existing;
                    selectedIndex = todayModules.indexOf(existing);
                } else {
                    selectedModule = todayModules[0];
                    selectedIndex = 0;
                }
            } else {
                selectedModule = todayModules[0];
                selectedIndex = 0;
            }
        }

        initQuizState(sender);
        userMemory[sender].quizState.moduleCode = selectedModule.code;
        userMemory[sender].quizState.moduleIndex = selectedIndex;
        userMemory[sender].quizState.questionCount = 10;
        userMemory[sender].quizState.lastQuizTime = Date.now();
        userMemory[sender].quizState.waitingForResponse = false;

        const moduleCode = selectedModule.code;
        const moduleName = selectedModule.fullName || moduleCode;

        const moduleKeywords = MODULE_FILE_MAP[moduleCode] || [moduleCode.toLowerCase()];
        const file = fileRegistry.find(f => {
            const keyword = f.keyword.toLowerCase();
            return moduleKeywords.some(kw => keyword.includes(kw)) || 
                   moduleKeywords.some(kw => (f.fileName || '').toLowerCase().includes(kw));
        });

        if (!file) {
            let message;
            if (isSenderAdmin(sender)) {
                message = `📭 ${moduleCode} සඳහා PDF File එකක් හම්බුනේ නැහැ.\n\n💡 *උපදෙස්:* අදාළ PDF එක \`add file: ${moduleCode} notes\` ලෙස Save කරන්න.`;
            } else {
                message = `📭 ${moduleCode} සඳහා PDF File එකක් තාම Add කරලා නැහැ. Batch Rep ට දැනුම් දෙන්න.`;
            }
            await sock.sendMessage(sender, { text: message }, { quoted: msg });
            return;
        }

        const filePath = path.join(FILES_DIR, file.storedFileName);
        if (!fs.existsSync(filePath)) {
            await sock.sendMessage(sender, { text: `❌ ${moduleCode} සඳහා File එක Server එකේ නෑ. Admin ට කියන්න.` }, { quoted: msg });
            return;
        }

        try {
            await sock.sendMessage(sender, { text: `📝 *${moduleCode}* සඳහා Quiz එක හදමින්...` }, { quoted: msg });

            const pdfBuffer = fs.readFileSync(filePath);
            const base64Pdf = pdfBuffer.toString('base64');
            const pdfPart = { inlineData: { data: base64Pdf, mimeType: 'application/pdf' } };

            const quizPrompt = `You are a university lecturer. Based on the following lecture content for the module "${moduleName}", create a quiz with 10 questions.

RULES:
- Questions should test understanding, not just memorization.
- Include a mix of: Multiple Choice, True/False, and Short Answer.
- Provide clear correct answers.
- Format the quiz neatly for WhatsApp (use bullet points, bold text, emojis).
- **Language Rule (Important!):**
  1. The quiz questions and the main correct answers MUST be in **English**.
  2. After providing the correct answer in English, add a line starting with *"💡 Sinhala Explanation:"* and write a brief, clear explanation in **Sinhala** for that specific answer so the student can easily understand it.
  3. Use simple Sinhala words (Singlish / Sinhala script is fine) to explain concepts that might be difficult.

LECTURE CONTENT:
${/* PDF will be sent as a part */ ''}

Generate the quiz now.`;

            geminiRequestsToday++;
            const result = await generateContentWithRetry(model, [quizPrompt, pdfPart]);
            const quizReply = formatMathForWhatsApp(result.response.text());

            const header = `📝 *${moduleCode} - Quiz* (${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })})\n───────────────────\n\n`;
            await sock.sendMessage(sender, { text: header + quizReply }, { quoted: msg });

            const todayModuleCodes = todayModules.map(m => m.code);
            const currentIndex = selectedIndex;
            const hasNextModule = currentIndex < todayModules.length - 1;
            const hasMoreQuestions = true;

            let followUpMsg = `\n✅ *ප්‍රශ්න 10 ඉවරයි!*\n\n`;
            if (hasMoreQuestions) {
                followUpMsg += `👉 *"more"* - ${moduleCode} එකෙන් තවත් ප්‍රශ්න 10ක් බලන්න. 📚\n`;
            }
            if (hasNextModule) {
                const nextModule = todayModules[currentIndex + 1];
                followUpMsg += `👉 *"next module"* - ${nextModule.code} එකෙන් Quiz එකක් බලන්න. 🔄\n`;
            }
            if (!hasMoreQuestions && !hasNextModule) {
                followUpMsg += `🎉 අද තියෙන හැම Module එකෙන්ම Quiz බැලුවා! ආයෙත් අදාළ Module එකක් Type කරන්න.`;
            } else {
                followUpMsg += `\n💡 *උදා:* "more" හෝ "next module" කියලා Type කරන්න.`;
            }

            userMemory[sender].quizState.waitingForResponse = true;
            await sock.sendMessage(sender, { text: followUpMsg }, { quoted: msg });

        } catch (error) {
            console.error(`Error generating quiz for ${moduleCode}:`, error);
            await sock.sendMessage(sender, { text: `❌ ${moduleCode} Quiz එක හදන්න බැරි වුණා. නැවත try කරන්න.` }, { quoted: msg });
        }

    } catch (error) {
        console.error('Quiz generation error:', error);
        await sock.sendMessage(sender, { text: "❌ Quiz එක හදන්න බැරි වුණා. නැවත try කරන්න." }, { quoted: msg });
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
                } catch (e) { 
                    if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                    if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
                    reject(e); 
                }
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
        const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'auth_info_baileys'));
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
                
                for (const jid of studentRegistry) {
                    if (!mataraStudents.includes(jid)) {
                        mataraStudents.push(jid);
                    }
                }
                saveMataraStudents();
                console.log(`📇 Registered ${mataraStudents.length} existing students as Matara students.`);
            }
        });

        cron.schedule('0 21 * * *', async () => {
            console.log('⏰ Running Tomorrow Timetable Push at 9:00 PM SL Time...');
            await sendDailyTimetable(sock);
        }, { timezone: 'Asia/Colombo' });

        cron.schedule('0 8 * * *', async () => {
            console.log('⏰ Running Deadline Check at 8:00 AM SL Time...');
            await checkDeadlines(sock);
        }, { timezone: 'Asia/Colombo' });

        cron.schedule('0 8 * * *', async () => {
            console.log('⏰ Running Exam Check at 8:00 AM SL Time...');
            await checkExams(sock);
        }, { timezone: 'Asia/Colombo' });

        async function processMessage(sock, msg) {
            const sender = msg.key.remoteJid;

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

            const isGroup = sender.endsWith('@g.us');
            if (isGroup) {
                if (isSenderAdmin(sender) && rawMessageText.toLowerCase().trim() === 'getid') {
                    await sock.sendMessage(sender, { text: `🆔 *Group ID:* \`${sender}\`` }, { quoted: msg });
                    return;
                }
                if (!GROUP_JID) {
                    console.log(`📢 Group ID Found (Silent Log): ${sender}`);
                }
                return; 
            }

            const isNewUser = addStudent(sender);
            if (isNewUser) {
                await sock.sendMessage(sender, { text: "Hello! I am *HansanaBot*, your AI assistant! 👋\n\nType *help* to see what I can do for you. 🚀" }, { quoted: msg });
            }

            const isMataraAdded = addMataraStudent(sender);
            if (isMataraAdded) {
                await sock.sendMessage(sender, { 
                    text: "📍 ඔබ Matara Centre Student කෙනෙක් ලෙස හඳුනාගෙන තියෙනවා! ඉදිරි Lab Submission Deadlines ගැන Reminders එවන්නම්! 📅" 
                }, { quoted: msg });
            }

            const rateCheck = checkRateLimit(sender);
            if (!rateCheck.allowed) {
                await sock.sendMessage(sender, { text: rateCheck.reason }, { quoted: msg });
                return;
            }   

            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate('composing', sender);

            // ================================================================
            //  🎤 VOICE COMMAND HANDLER
            // ================================================================
            if (audioMsg) {
                try {
                    await sock.sendMessage(sender, { text: "🎙️ **Voice Note Process වෙමින්...**" }, { quoted: msg });
                    const oggBuffer = await downloadMediaMessage(msg, 'buffer', {});
                    const mp3Buffer = await convertAudioToMp3(oggBuffer);
                    const base64Audio = mp3Buffer.toString('base64');
                    const audioPart = { inlineData: { data: base64Audio, mimeType: 'audio/mp3' } };

                    const transcribePrompt = "Transcribe the following audio message accurately. Output only the transcribed text, nothing else.";
                    const transcribeResult = await generateContentWithRetry(model, [transcribePrompt, audioPart]);
                    const transcribedText = transcribeResult.response.text().trim();
                    console.log('🎤 Transcribed:', transcribedText);

                    const intent = detectIntentFromText(transcribedText);
                    if (intent.intent === 'calendar') {
                        const { start, end, targetDate } = getTargetDateRange(intent.data || transcribedText);
                        const events = await getCalendarEvents(start, end);
                        if (events && events.length > 0) {
                            let msgText = `📅 *${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })} දින Classes:*\n\n`;
                            events.forEach((ev, idx) => {
                                const startTime = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' });
                                const endTime = new Date(ev.end?.dateTime || ev.end?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' });
                                const location = ev.location || '';
                                msgText += `${idx+1}. *${ev.summary || 'Untitled'}*\n   🕒 ${startTime} – ${endTime}\n`;
                                if (location) msgText += `   📍 ${location}\n\n`;
                            });
                            msgText += `\n🔗 *Full Calendar:* https://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(CALENDAR_ID)}`;
                            await sock.sendMessage(sender, { text: msgText }, { quoted: msg });
                        } else {
                            await sock.sendMessage(sender, { text: `🎉 *${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })}* දිනට Classes නෑ!` }, { quoted: msg });
                        }
                    } else if (intent.intent === 'quiz') {
                        await handleQuizCommand(sock, sender, msg, intent.data);
                    } else if (intent.intent === 'pdf') {
                        const moduleCodes = ['SE1020', 'IT1170', 'IT1160', 'IT1150', 'IE1011'];
                        let matchedFile = null;
                        for (const code of moduleCodes) {
                            if (transcribedText.toUpperCase().includes(code)) {
                                matchedFile = fileRegistry.find(f => 
                                    f.keyword.toLowerCase().includes(code.toLowerCase()) ||
                                    (f.fileName || '').toLowerCase().includes(code.toLowerCase())
                                );
                                break;
                            }
                        }
                        if (matchedFile) {
                            const filePath = path.join(FILES_DIR, matchedFile.storedFileName);
                            if (fs.existsSync(filePath)) {
                                const buffer = fs.readFileSync(filePath);
                                await sock.sendMessage(sender, {
                                    document: buffer,
                                    mimetype: matchedFile.mimetype || 'application/pdf',
                                    fileName: matchedFile.fileName || 'document.pdf'
                                }, { quoted: msg });
                            } else {
                                await sock.sendMessage(sender, { text: "❌ File එක Server එකේ නෑ." }, { quoted: msg });
                            }
                        } else {
                            await sock.sendMessage(sender, { text: "📭 ඔබ ඇසූ Module එක සඳහා File එකක් හම්බුනේ නැහැ." }, { quoted: msg });
                        }
                    } else {
                        const prompt = buildPromptWithKnowledge(`User said (voice note): "${transcribedText}"\n\nReply naturally. If relevant, use the batch rep's memory to answer.`);
                        const result = await generateContentWithRetry(model, prompt);
                        const reply = formatMathForWhatsApp(result.response.text());
                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                    }
                } catch (err) {
                    console.error('Audio error:', err);
                    await sock.sendMessage(sender, { text: "❌ Voice message එක process කරන්න බැරි වුණා." }, { quoted: msg });
                }
                return;
            }

            // ---------- ADD FILE ----------
            if ((docMsg || imgMsg) && /^add file\b/i.test(rawMessageText.toLowerCase().trim())) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ මේක කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                let keyword = rawMessageText.replace(/^add file\s*:?\s*/i, '').trim().toLowerCase();
                const media = docMsg || imgMsg;
                const ext = path.extname(media.fileName || '') || (docMsg ? '.pdf' : '.jpg');

                if (!keyword && docMsg && docMsg.mimetype === 'application/pdf') {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const base64Pdf = buffer.toString('base64');
                        const pdfPart = { inlineData: { data: base64Pdf, mimeType: 'application/pdf' } };
                        const detectPrompt = "Extract the module code (like SE1020, IT1170, etc.) from this PDF. If multiple, return the first one. Output only the code, nothing else.";
                        const result = await generateContentWithRetry(model, [detectPrompt, pdfPart]);
                        keyword = result.response.text().trim().toUpperCase();
                        if (!keyword || keyword.length < 4) {
                            keyword = media.fileName ? media.fileName.replace(/\.[^.]+$/, '').toLowerCase() : 'file';
                        }
                        console.log(`🤖 Auto-detected keyword: ${keyword}`);
                    } catch (e) {
                        keyword = media.fileName ? media.fileName.replace(/\.[^.]+$/, '').toLowerCase() : 'file';
                    }
                } else if (!keyword) {
                    keyword = media.fileName ? media.fileName.replace(/\.[^.]+$/, '').toLowerCase() : 'file';
                }

                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const storedFileName = `${crypto.randomUUID()}${ext}`;
                    fs.writeFileSync(path.join(FILES_DIR, storedFileName), buffer);
                    fileRegistry.push({
                        keyword,
                        fileName: media.fileName || `${keyword}${ext}`,
                        mimetype: media.mimetype || (docMsg ? 'application/pdf' : 'image/jpeg'),
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
                        const result = await generateContentWithRetry(model, [prompt, pdfPart]);
                        const reply = formatMathForWhatsApp(result.response.text());
                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                    }
                } catch (err) {
                    console.error('PDF error:', err);
                    await sock.sendMessage(sender, { text: "❌ File එක විවෘත කරන්න බැරි වුණා." }, { quoted: msg });
                }
                return;
            }

            // ---------- IMAGE ----------
            if (imgMsg) {
                try {
                    await sock.sendMessage(sender, { text: "⏳ **Image එක විශ්ලේෂණය කරමින්...**" }, { quoted: msg });
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const base64Image = buffer.toString('base64');
                    const mimeType = imgMsg.mimetype || 'image/jpeg';
                    const imagePart = { inlineData: { data: base64Image, mimeType: mimeType } };
                    
                    const prompt = buildPromptWithKnowledge(`Please analyze the attached image carefully. If it contains a table, schedule, timetable, or any other information, extract all the text/data accurately. If the user has asked a question (e.g., "What is the schedule?", "When is the exam?"), answer based on the image provided. User's question: "${rawMessageText || 'Explain this image'}"`);
                    
                    const result = await generateContentWithRetry(model, [prompt, imagePart]);
                    const reply = formatMathForWhatsApp(result.response.text());
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                } catch (err) {
                    console.error('Image error:', err);
                    await sock.sendMessage(sender, { text: "❌ Image එක process කරන්න බැරි වුණා." }, { quoted: msg });
                }
                return;
            }

            // ================================================================
            //  📝 TEXT COMMANDS
            // ================================================================
            const textLower = rawMessageText.toLowerCase().trim();

            // ---------- QUIZ COMMAND ----------
            if (textLower === 'quiz' || textLower === 'quiz එකක්' || textLower === 'quiz ekk' || 
                textLower.startsWith('quiz ') || textLower.includes('ක්විස්') || textLower.includes('ප්‍රශ්න')) {
                const moduleMatch = textLower.match(/(SE|IT|IE)\d{4}/i);
                const moduleQuery = moduleMatch ? moduleMatch[0].toUpperCase() : '';
                await handleQuizCommand(sock, sender, msg, moduleQuery);
                return;
            }

            // ---------- QUIZ FOLLOW-UP ----------
            const isQuizFollowUp = textLower === 'more' || textLower === 'ඉවරයි' || textLower === 'තවත්' || 
                                   textLower === 'next' || textLower === 'next module' || textLower === 'වෙනත්' || 
                                   textLower === 'switch' || textLower === 'මීළඟ';

            if (isQuizFollowUp) {
                initQuizState(sender);
                const state = userMemory[sender].quizState;
                if (!state.moduleCode || !state.waitingForResponse) {
                    await sock.sendMessage(sender, { text: "⚠️ ඔබ දැනට quiz session එකක් පටන් ගෙන නැහැ. `quiz` කියලා type කරන්න." }, { quoted: msg });
                    return;
                }

                if (textLower === 'more' || textLower === 'තවත්' || textLower === 'ඉවරයි') {
                    await handleQuizCommand(sock, sender, msg, state.moduleCode);
                    return;
                }

                if (textLower === 'next module' || textLower === 'වෙනත්' || textLower === 'switch' || textLower === 'next' || textLower === 'මීළඟ') {
                    const { start, end } = getTargetDateRange('today');
                    const events = await getCalendarEvents(start, end);
                    if (events && events.length > 0) {
                        const todayModules = [];
                        events.forEach(ev => {
                            const summary = ev.summary || '';
                            const moduleCodeMatch = summary.match(/(SE|IT|IE)\d{4}/i);
                            if (moduleCodeMatch) {
                                todayModules.push({
                                    code: moduleCodeMatch[0].toUpperCase(),
                                    fullName: summary,
                                    event: ev
                                });
                            }
                        });
                        const currentIndex = state.moduleIndex;
                        const nextIndex = currentIndex + 1;
                        if (nextIndex < todayModules.length) {
                            const nextModule = todayModules[nextIndex];
                            await handleQuizCommand(sock, sender, msg, nextModule.code);
                        } else {
                            await sock.sendMessage(sender, { text: "🎉 අද තියෙන හැම Module එකෙන්ම Quiz බැලුවා! ආයෙත් `quiz` කියලා type කරන්න." }, { quoted: msg });
                        }
                    } else {
                        await sock.sendMessage(sender, { text: "📭 අද Classes නෑ, ඒ නිසා වෙනත් Module එකක් නැහැ." }, { quoted: msg });
                    }
                    return;
                }
            }

            // ---------- SMART PDF COMMAND ----------
            const pdfKeywords = /\b(pdf|file|danna|ewanna|notes|note|file eka|pdf eka|සටහන්|notes)\b/i;
            if (pdfKeywords.test(textLower) || textLower === 'pdf' || textLower === 'file') {
                let matchedFile = null;
                let detectedModule = null;

                const moduleCodes = ['SE1020', 'IT1170', 'IT1160', 'IT1150', 'IE1011'];
                for (const code of moduleCodes) {
                    if (textLower.toUpperCase().includes(code)) {
                        detectedModule = code;
                        matchedFile = fileRegistry.find(f => 
                            f.keyword.toLowerCase().includes(code.toLowerCase()) ||
                            (f.fileName || '').toLowerCase().includes(code.toLowerCase())
                        );
                        break;
                    }
                }

                if (!matchedFile) {
                    const history = userMemory[sender] || [];
                    let lastModule = null;
                    for (let i = history.length - 1; i >= 0; i--) {
                        const msgText = history[i].text || '';
                        for (const code of moduleCodes) {
                            if (msgText.toUpperCase().includes(code)) {
                                lastModule = code;
                                break;
                            }
                        }
                        if (lastModule) break;
                    }
                    if (lastModule) {
                        detectedModule = lastModule;
                        matchedFile = fileRegistry.find(f => 
                            f.keyword.toLowerCase().includes(lastModule.toLowerCase()) ||
                            (f.fileName || '').toLowerCase().includes(lastModule.toLowerCase())
                        );
                    }
                }

                if (!matchedFile) {
                    const { start, end } = getTargetDateRange('today');
                    const events = await getCalendarEvents(start, end);
                    if (events && events.length > 0) {
                        for (const ev of events) {
                            const summary = ev.summary || '';
                            const codeMatch = summary.match(/(SE|IT|IE)\d{4}/i);
                            if (codeMatch) {
                                const code = codeMatch[0].toUpperCase();
                                detectedModule = code;
                                const f = fileRegistry.find(f => 
                                    f.keyword.toLowerCase().includes(code.toLowerCase()) ||
                                    (f.fileName || '').toLowerCase().includes(code.toLowerCase())
                                );
                                if (f) { matchedFile = f; break; }
                            }
                        }
                    }
                }

                if (!matchedFile) {
                    if (fileRegistry.length === 0) {
                        await sock.sendMessage(sender, { text: "📭 කිසිම file එකක් save කරලා නැහැ. Batch Rep ට කියලා Add කරගන්න." }, { quoted: msg });
                        return;
                    }
                    if (detectedModule) {
                        await sock.sendMessage(sender, { text: `📭 *${detectedModule}* සඳහා File එකක් හම්බුනේ නැහැ.\n\nමෙන්න තියෙන Files:\n${fileRegistry.map((f, i) => `${i+1}. ${f.keyword}`).join('\n')}\n\n👉 Type කරන්න: \`${fileRegistry[0].keyword}\`` }, { quoted: msg });
                    } else {
                        const fileList = fileRegistry.map((f, i) => `${i+1}. *${f.keyword}*`).join('\n');
                        await sock.sendMessage(sender, { 
                            text: `📂 *Available Files:*\n\n${fileList}\n\n💡 ඔබට ඕන file එකේ keyword එක type කරන්න (e.g., *${fileRegistry[0].keyword}*)` 
                        }, { quoted: msg });
                    }
                    return;
                }

                try {
                    const filePath = path.join(FILES_DIR, matchedFile.storedFileName);
                    if (fs.existsSync(filePath)) {
                        const buffer = fs.readFileSync(filePath);
                        await sock.sendMessage(sender, {
                            document: buffer,
                            mimetype: matchedFile.mimetype || 'application/pdf',
                            fileName: matchedFile.fileName || 'document.pdf'
                        }, { quoted: msg });
                        lastFileContext[sender] = matchedFile;
                    } else {
                        await sock.sendMessage(sender, { text: "❌ File එක Server එකේ නෑ. Admin ට කියලා ආයේ Add කරන්න." }, { quoted: msg });
                    }
                } catch (err) {
                    console.error('❌ Error sending file:', err);
                    await sock.sendMessage(sender, { text: "❌ File එක යවන්න අවුලක් වුණා. නැවත try කරන්න." }, { quoted: msg });
                }
                return;
            }

            // ---------- ADMIN MENU ----------
            if (textLower === 'admin' || textLower === 'admin menu' || textLower === 'menu admin' || textLower === 'adminhelp' || textLower === '/admin') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ මේක බලන්න පුළුවන් Batch Rep ට විතරයි! 🚫" }, { quoted: msg });
                    return;
                }
                
                const adminHelpText = `🛠️ *Admin Control Panel* (Batch Rep Only) 🛡️

🧠 *Memory (Bot ට මතක තබා ගන්න):*
📝 *add info: [text]* - Bot ට අලුත් දෙයක් මතක තබා ගන්න
📚 *list info* - Bot ට මතක තියෙන දේවල් බලන්න
🗑️ *remove info [number]* - එකක් අයින් කරන්න

📁 *File Management:*
📤 *add file: [keyword]* - PDF/Image එකක් save කරන්න
📋 *list files* - Files බලන්න
🗑️ *remove file [number]* - File එකක් අයින් කරන්න

📊 *Bot Management:*
📊 *status* - Bot Status
🆔 *getid* - Group ID

💡 *Tip:* "add info" කරන හැම දෙයක්ම Bot **JARVIS වගේ මතක තබාගෙන** ළමයෙක් ඇසුවොත් ස්වභාවිකව උත්තර දෙනවා.`;

                await sock.sendMessage(sender, { text: adminHelpText }, { quoted: msg });
                return;
            }

            // ---------- POLL ----------
            if (textLower.startsWith('poll ') && isSenderAdmin(sender)) {
                const pollArgs = rawMessageText.slice(5).split('|').map(s => s.trim());
                
                if (pollArgs.length < 3) {
                    await sock.sendMessage(sender, { text: "⚠️ හරි Format එක: `poll ප්‍රශ්නය? | විකල්පය 1 | විකල්පය 2`" }, { quoted: msg });
                    return;
                }

                const pollName = pollArgs[0];
                const pollValues = pollArgs.slice(1, 13);

                try {
                    await sock.sendMessage(sender, {
                        poll: {
                            name: pollName,
                            values: pollValues
                        }
                    }, { quoted: msg });
                } catch (e) {
                    console.error('Poll error:', e);
                    await sock.sendMessage(sender, { text: "❌ Poll එක හදන්න අවුලක් වුණා." }, { quoted: msg });
                }
                return;
            }

            // ---------- STATUS ----------
            if (textLower === 'status') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const statusMsg = `✅ *HansanaBot Status*\n\n🧠 *Memory Entries:* ${knowledgeBase.length}\n👥 *Used Requests:* ${geminiRequestsToday}/500\n📁 *Total Files:* ${fileRegistry.length}\n👥 *Registered Students:* ${studentRegistry.length}\n📍 *Matara Students:* ${mataraStudents.length}\n📅 *Deadlines:* ${deadlines.length}\n📝 *Exams:* ${exams.length}`;
                await sock.sendMessage(sender, { text: statusMsg }, { quoted: msg });
                return;
            }

            // ---------- ADD INFO (Memory - JARVIS Style) ----------
            if (/^(add info|info add|save info|remember)\b/i.test(textLower)) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const infoText = rawMessageText.replace(/^(add info|info add|save info|remember)\s*:?\s*/i, '').trim();
                if (!infoText) {
                    await sock.sendMessage(sender, { text: "⚠️ මතක තබා ගන්න ඕන දේ type කරන්න.\n\nඋදා: `add info: ලබන සතියේ exam තියෙනවා`" }, { quoted: msg });
                    return;
                }
                
                await sock.sendMessage(sender, { text: "🧠 මතක තබා ගනිමින්..." }, { quoted: msg });
                const calculatedDate = await calculateDateFromText(infoText);
                
                knowledgeBase.push({
                    text: infoText,
                    addedAt: new Date().toISOString(),
                    addedBy: 'Monal Hansana',
                    calculatedDate: calculatedDate || null
                });
                saveKnowledgeBase();
                
                let confirmMsg = `🧠 *මතක තබා ගත්තා!*\n\n📝 "${infoText}"`;
                if (calculatedDate) {
                    confirmMsg += `\n\n🗓️ *ගණනය කළ දිනය: ${calculatedDate}*`;
                }
                confirmMsg += `\n\nදැන් ළමයෙක් මේ ගැන ඇසුවොත්, මම JARVIS වගේ උත්තර දෙන්නම්! ✅\n\n_Total Memory: ${knowledgeBase.length}_`;
                
                await sock.sendMessage(sender, { text: confirmMsg }, { quoted: msg });
                return;
            }

            // ---------- REMOVE INFO ----------
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
                const removedText = typeof removed[0] === 'string' ? removed[0] : removed[0].text;
                await sock.sendMessage(sender, { text: `🗑️ අයින් කළා: "${removedText}"` }, { quoted: msg });
                return;
            }

            // ---------- LIST INFO (Memory) ----------
            if (textLower === 'list info' || textLower === 'show info' || textLower === 'list memory' || textLower === 'my memory') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                if (knowledgeBase.length === 0) {
                    await sock.sendMessage(sender, { text: "📭 දැනට මතක මොකවත් නෑ." }, { quoted: msg });
                } else {
                    const list = knowledgeBase.map((k, i) => {
                        const text = typeof k === 'string' ? k : k.text;
                        const addedAt = k.addedAt ? new Date(k.addedAt).toLocaleDateString('en-LK', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
                        const calcDate = k.calculatedDate ? `\n   🗓️ Actual Date: ${k.calculatedDate}` : '';
                        return `${i+1}. ${text}${addedAt ? `\n   _(Added: ${addedAt})_` : ''}${calcDate}`;
                    }).join('\n\n');
                    await sock.sendMessage(sender, { 
                        text: `🧠 *Bot Memory (${knowledgeBase.length})*\n\n${list}` 
                    }, { quoted: msg });
                }
                return;
            }

            // ---------- LIST FILES ----------
            if (textLower === 'list files' || textLower === 'show files') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                if (fileRegistry.length === 0) {
                    await sock.sendMessage(sender, { text: "📭 No files saved." }, { quoted: msg });
                } else {
                    const list = fileRegistry.map((f, i) => `${i+1}. "${f.keyword}" → ${f.fileName}`).join('\n');
                    await sock.sendMessage(sender, { text: `📁 *Saved Files (${fileRegistry.length})*\n\n${list}` }, { quoted: msg });

                    for (const f of fileRegistry) {
                        const filePath = path.join(FILES_DIR, f.storedFileName);
                        if (fs.existsSync(filePath)) {
                            const buffer = fs.readFileSync(filePath);
                            await sock.sendMessage(sender, {
                                document: buffer,
                                mimetype: f.mimetype || 'application/pdf',
                                fileName: f.fileName || 'document.pdf'
                            }, { quoted: msg });
                            await new Promise(r => setTimeout(r, 1500));
                        } else {
                            console.error(`File not found: ${filePath}`);
                        }
                    }
                }
                return;
            }

            // ---------- REMOVE FILE ----------
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

            // ---------- DEADLINE COMMANDS (Admin) ----------
            const deadlineMatch = rawMessageText.match(/^add deadline\s*:?\s*(.+?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d{2}:\d{2})\s*\|\s*(.+)$/i);
            if (deadlineMatch && isSenderAdmin(sender)) {
                const description = deadlineMatch[1].trim();
                const dateStr = deadlineMatch[2].trim();
                const timeStr = deadlineMatch[3].trim();
                const centre = deadlineMatch[4].trim();
                
                const dateObj = new Date(`${dateStr}T${timeStr}`);
                if (isNaN(dateObj.getTime())) {
                    await sock.sendMessage(sender, { text: "⚠️ වැරදි date හෝ time format. හරි format: YYYY-MM-DD | HH:MM | Centre" }, { quoted: msg });
                    return;
                }
                
                deadlines.push({
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                    description,
                    date: dateStr,
                    time: timeStr,
                    centre: centre.toLowerCase(),
                    createdAt: new Date().toISOString()
                });
                saveDeadlines();
                await sock.sendMessage(sender, { 
                    text: `✅ Deadline added!\n📝 ${description}\n📅 ${dateStr}\n🕐 ${timeStr}\n📍 ${centre}` 
                }, { quoted: msg });
                return;
            }

            // Bulk add deadlines
            if (textLower.startsWith('add deadlines:') && isSenderAdmin(sender)) {
                const lines = rawMessageText.replace(/^add deadlines\s*:?\s*/i, '').split('\n').filter(line => line.trim());
                let addedCount = 0;
                let errorCount = 0;
                
                for (const line of lines) {
                    const match = line.match(/^(.+?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d{2}:\d{2})\s*\|\s*(.+)$/);
                    if (match) {
                        const description = match[1].trim();
                        const dateStr = match[2].trim();
                        const timeStr = match[3].trim();
                        const centre = match[4].trim();
                        const dateObj = new Date(`${dateStr}T${timeStr}`);
                        if (!isNaN(dateObj.getTime())) {
                            deadlines.push({
                                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                                description,
                                date: dateStr,
                                time: timeStr,
                                centre: centre.toLowerCase(),
                                createdAt: new Date().toISOString()
                            });
                            addedCount++;
                        } else {
                            errorCount++;
                        }
                    } else {
                        errorCount++;
                    }
                }
                
                saveDeadlines();
                await sock.sendMessage(sender, { 
                    text: `✅ Deadlines added!\n📝 Added: ${addedCount}\n❌ Failed: ${errorCount}` 
                }, { quoted: msg });
                return;
            }

            // List deadlines
            if (textLower === 'list deadlines' || textLower === 'show deadlines') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                if (deadlines.length === 0) {
                    await sock.sendMessage(sender, { text: "📭 No deadlines saved." }, { quoted: msg });
                } else {
                    const sorted = [...deadlines].sort((a, b) => {
                        const dateA = new Date(`${a.date}T${a.time || '23:59'}`);
                        const dateB = new Date(`${b.date}T${b.time || '23:59'}`);
                        return dateA - dateB;
                    });
                    const list = sorted.map((d, i) => {
                        const dt = new Date(`${d.date}T${d.time || '23:59'}`);
                        return `${i+1}. *${d.description}*\n   📅 ${dt.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })}\n   🕐 ${dt.toLocaleTimeString('en-LK', { hour: '2-digit', minute: '2-digit' })}\n   📍 ${d.centre}\n`;
                    }).join('\n');
                    await sock.sendMessage(sender, { text: `📅 *All Deadlines (${sorted.length})*\n\n${list}` }, { quoted: msg });
                }
                return;
            }

            // Remove deadline
            if (/^remove deadline\s+\d+/i.test(textLower)) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const idx = parseInt(textLower.replace(/^remove deadline\s+/i, ''), 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= deadlines.length) {
                    await sock.sendMessage(sender, { text: "⚠️ Invalid number. Use 'list deadlines' to see." }, { quoted: msg });
                    return;
                }
                const [removed] = deadlines.splice(idx, 1);
                saveDeadlines();
                await sock.sendMessage(sender, { text: `🗑️ Removed: "${removed.description}"` }, { quoted: msg });
                return;
            }

            // ---------- EXAM COMMANDS (Admin) ----------
            const examMatch = rawMessageText.match(/^add exam\s*:?\s*(.+?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d{2}:\d{2})\s*\|\s*(.+?)\s*\|\s*(.+)$/i);
            if (examMatch && isSenderAdmin(sender)) {
                const description = examMatch[1].trim();
                const dateStr = examMatch[2].trim();
                const timeStr = examMatch[3].trim();
                const centre = examMatch[4].trim();
                const type = examMatch[5].trim();
                
                const dateObj = new Date(`${dateStr}T${timeStr}`);
                if (isNaN(dateObj.getTime())) {
                    await sock.sendMessage(sender, { text: "⚠️ වැරදි date හෝ time format. හරි format: YYYY-MM-DD | HH:MM | Centre | ExamType" }, { quoted: msg });
                    return;
                }
                
                exams.push({
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                    description,
                    date: dateStr,
                    time: timeStr,
                    centre: centre.toLowerCase(),
                    type: type,
                    createdAt: new Date().toISOString()
                });
                saveExams();
                await sock.sendMessage(sender, { 
                    text: `✅ Exam added!\n📝 ${description}\n📅 ${dateStr}\n🕐 ${timeStr}\n📍 ${centre}\n📋 ${type}` 
                }, { quoted: msg });
                return;
            }

            // List exams (Admin only)
            if (textLower === 'list exams' || textLower === 'show exams') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                if (exams.length === 0) {
                    await sock.sendMessage(sender, { text: "📭 No exams saved." }, { quoted: msg });
                } else {
                    const sorted = [...exams].sort((a, b) => {
                        const dateA = new Date(`${a.date}T${a.time || '23:59'}`);
                        const dateB = new Date(`${b.date}T${b.time || '23:59'}`);
                        return dateA - dateB;
                    });
                    const list = sorted.map((e, i) => {
                        const dt = new Date(`${e.date}T${e.time || '23:59'}`);
                        return `${i+1}. *${e.description}*\n   📅 ${dt.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })}\n   🕐 ${dt.toLocaleTimeString('en-LK', { hour: '2-digit', minute: '2-digit' })}\n   📍 ${e.centre}\n   📋 ${e.type || 'Exam'}\n`;
                    }).join('\n');
                    await sock.sendMessage(sender, { text: `📝 *All Exams (${sorted.length})*\n\n${list}` }, { quoted: msg });
                }
                return;
            }

            // Remove exam
            if (/^remove exam\s+\d+/i.test(textLower)) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const idx = parseInt(textLower.replace(/^remove exam\s+/i, ''), 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= exams.length) {
                    await sock.sendMessage(sender, { text: "⚠️ Invalid number. Use 'list exams' to see." }, { quoted: msg });
                    return;
                }
                const [removed] = exams.splice(idx, 1);
                saveExams();
                await sock.sendMessage(sender, { text: `🗑️ Removed: "${removed.description}"` }, { quoted: msg });
                return;
            }

            // ================================================================
            //  📅 CALENDAR COMMAND
            // ================================================================
            const aiIntent = detectIntentFromText(rawMessageText);

            if (aiIntent.intent === 'calendar') {
                const lowerText = rawMessageText.toLowerCase().trim();

                if (lowerText === 'calendar' || lowerText === 'timetable' || 
                    lowerText === 'week' || lowerText === 'weekly' || 
                    lowerText.includes('me sathiya') || lowerText.includes('මේ සතිය') ||
                    lowerText.includes('me satiya') || lowerText.includes('තිම් ටේබල්')) {
                    
                    const { start, end, weekStart } = getCurrentWeekRange();
                    const events = await getCalendarEvents(start, end);
                    
                    const startDateStr = weekStart.toLocaleDateString('en-LK', { day: 'numeric', month: 'short' });
                    const endDateStr = new Date(end).toLocaleDateString('en-LK', { day: 'numeric', month: 'short', year: 'numeric' });
                    let msgText = `📅 *මේ සතියේ Classes (${startDateStr} - ${endDateStr})*\n\n`;
                    
                    if (events && events.length > 0) {
                        const days = {};
                        events.forEach(ev => {
                            const evDate = new Date(ev.start?.dateTime || ev.start?.date);
                            const dateKey = evDate.toLocaleDateString('en-LK', { weekday: 'long', day: 'numeric', month: 'short' });
                            if (!days[dateKey]) days[dateKey] = [];
                            days[dateKey].push(ev);
                        });

                        const sortedDays = Object.keys(days).sort((a, b) => {
                            const dateA = new Date(a);
                            const dateB = new Date(b);
                            return dateA - dateB;
                        });

                        sortedDays.forEach((day) => {
                            msgText += `*${day}*\n`;
                            days[day].forEach((ev) => {
                                const startTime = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' });
                                const endTime = new Date(ev.end?.dateTime || ev.end?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' });
                                const location = ev.location || '';
                                msgText += `   🕒 ${startTime} - ${endTime}  *${ev.summary || 'Untitled'}*`;
                                if (location) msgText += ` (${location})`;
                                msgText += `\n`;
                            });
                            msgText += `\n`;
                        });
                    } else {
                        msgText += "🎉 මේ සතියේ Classes නෑ! Free Week! 💯";
                    }
                    
                    await sock.sendMessage(sender, { text: msgText }, { quoted: msg });
                    return;
                }

                const { start, end, targetDate } = getTargetDateRange(aiIntent.data || lowerText);
                const events = await getCalendarEvents(start, end);

                if (events && events.length > 0) {
                    let msgTextDay = `📅 *${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })} දින Classes:*\n\n`;
                    events.forEach((ev, idx) => {
                        const startTime = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute:'2-digit' });
                        const endTime = new Date(ev.end?.dateTime || ev.end?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute:'2-digit' });
                        const location = ev.location || '';
                        const description = ev.description || '';
                        
                        msgTextDay += `${idx+1}. *${ev.summary || 'Untitled'}*\n`;
                        msgTextDay += `   🕒 ${startTime} – ${endTime}\n`;
                        if (location) msgTextDay += `   📍 *ස්ථානය (Location):* ${location}\n`;
                        if (description) msgTextDay += `   📝 *විස්තරය (Details):* ${cleanHTML(description)}\n`;
                        msgTextDay += `\n`;
                    });
                    msgTextDay += `\n🔗 *Full Calendar:* https://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(CALENDAR_ID)}`;
                    await sock.sendMessage(sender, { text: msgTextDay }, { quoted: msg });
                } else {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const futureDate = new Date(targetDate);
                    futureDate.setHours(0, 0, 0, 0);
                    const diffDays = Math.ceil((futureDate - today) / (1000 * 60 * 60 * 24));

                    if (diffDays >= 3) {
                        await sock.sendMessage(sender, { text: `⚠️ *${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })}* දිනට අදාළ Timetable එක තාම Google Calendar එකට එකතු කරලා නැහැ. ටික වේලාවකින් ආයේ අහන්න, නැත්නම් Batch Rep ට දැනුම් දෙන්න!` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(sender, { text: `🎉 *${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })}* දිනට Classes නෑ!` }, { quoted: msg });
                    }
                }
                return;
            }

            // ---------- OTHER COMMANDS ----------
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

            // GEN Z GUIDE
            if (textLower === 'guide' || textLower === 'genz' || textLower === 'how to use') {
                const genZGuide = `Yo bestie! 👋🔥 I'm *HansanaBot*, your AI slay assistant! No cap, I got your back! 🫡✨

🛠️ *How to use me (fr fr):*
👉 Just ask me anything! I understand *"ada timetable"*, *"heta class"*, *"SE1020 notes"*, *"quiz"*, etc.
👉 Need notes? Just say *"pdf"* or *"SE1020 notes"*!
👉 Want a quiz? Just say *"quiz"* or *"quiz SE1020"*!
👉 Got a random question? Just ask me in Sinhala or English!
👉 And I remember what Monal tells me — like a personal assistant. 🧠
👉 *"status"* is only for the main character (Admin) 💅

Catch my drift? Slide into my DMs and let's get that GPA up! 📈🚀`;
                await sock.sendMessage(sender, { text: genZGuide }, { quoted: msg });
                return;
            }

            // HELP MENU
            if (textLower === 'help' || textLower === '/help' || textLower === 'menu' || textLower === '/menu' || 
                textLower === 'start' || textLower === '/start' || textLower === 'commands' || 
                textLower === 'hi' || textLower === 'hello' || textLower === 'hey' || textLower === 'hii' || 
                textLower === 'hlo' || textLower === 'hi there' || textLower === 'good morning' || 
                textLower === 'good night' || textLower === 'suba' || textLower === 'ayubowan') {
                
                const isAdmin = isSenderAdmin(sender);
                
                let helpText = `👋 *HansanaBot Help Menu* 🤖
                
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *General Commands* (For Everyone)

📖 *guide* - Gen Z Style Guide එක බලන්න
🆔 *whoami* - ඔයාගේ WhatsApp ID එක බලන්න
👤 *who am i* - Adminද Studentද කියලා බලන්න
💬 *ඕනෑම ප්‍රශ්නයක්* - මම AI Assistant කෙනෙක්, ඉතින් කතා කරන්න!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 *Timetable & Calendar*

📅 *calendar / timetable* - මේ සතියේ Classes
📅 *ada class* - අද Classes
📅 *heta class* - හෙට Classes
📅 *anidda class* - අනිද්දා Classes
📅 *Monday / Tuesday ...* - ඕනෑම දිනයක Classes
📅 *calendar help* - Calendar Troubleshooting Guide

⏰ *Daily Auto Update:* සෑම රෑ 9 ට හෙට දවසේ *Timetable + Word of the Day* එක යවයි.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📂 *Smart PDF System*

📂 *pdf / file / danna* - ඔබට අදාළ Module එකේ File එක Auto ලබා ගන්න
📂 *[module code]* - e.g., *SE1020* type කරලා File එක Direct ලබා ගන්න

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 *Quiz System*

📝 *quiz* - අද දවසේ පළමු Module එකෙන් ප්‍රශ්න 10ක්
📝 *quiz SE1020* - Specific Module එකෙන් Quiz එකක්
   (ඉවර වුනාම *more* හෝ *next module* කියලා Type කරන්න)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎤 *Voice Commands*

🎙️ *Voice Note එකක් යවන්න* - "හෙට timetable එක දෙන්න" වගේ කියන්න
   (Bot එක auto detect කරලා Timetable එක යවයි)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 *Learning & Fun*

📖 *word / vocabulary* - Academic Word Practice (නව වචන ඉගෙන ගන්න)
✨ *motivate me* - Daily Motivation Quote එකක්
🧩 *riddle* - Riddle එකක්
💡 *answer* - Riddle එකේ Answer එක

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❓ *Other*

❓ *help / menu* - මෙම Help Menu එක
🙏 *thanks / stuti* - Auto Thanks Reply

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 *Support*
Contact Batch Rep: +94 76 251 3957
Email: it26100930@my.sliit.lk`;

                if (isAdmin) {
                    helpText += `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛠️ *Admin Commands* (Batch Rep Only) 🛡️

🧠 *Memory (Bot ට මතක තබා ගන්න):*
📝 *add info: [text]* - Bot ට අලුත් දෙයක් මතක තබා ගන්න
   (උදා: "add info: ලබන සතියේ exam තියෙනවා")
📚 *list info* / *list memory* - Bot ට මතක තියෙන දේවල් බලන්න
🗑️ *remove info [number]* - එකක් අයින් කරන්න

📁 *File Management:*
📤 *add file: [keyword]* - PDF/Image එකක් save කරන්න
   (Keyword නැතුව upload කළොත් AI එකෙන් auto detect වෙයි!)
📋 *list files* - Save කරලා තියෙන Files ටික බලන්න
🗑️ *remove file [number]* - File එකක් අයින් කරන්න

📊 *Bot Management:*
📊 *status* - Bot එකේ තත්වය බලන්න
📊 *poll Question? | Option 1 | Option 2* - WhatsApp Poll එකක් හදන්න
🆔 *getid* - Group ID එක ගන්න

📅 *Deadline Management (Matara Centre):*
📝 *add deadline: Description | YYYY-MM-DD | HH:MM | Matara* - Add deadline
📚 *list deadlines* - View all deadlines
🗑️ *remove deadline [number]* - Remove deadline

📝 *Exam Management (Matara Centre):*
📝 *add exam: Description | YYYY-MM-DD | HH:MM | Matara | ExamType* - Add exam
📚 *list exams* - View all exams
🗑️ *remove exam [number]* - Remove exam

💡 *Tip:* "add info" කරන හැම දෙයක්ම Bot **JARVIS වගේ මතක තබාගෙන** ළමයෙක් ඇසුවොත් ස්වභාවිකව උත්තර දෙනවා. 🧠✨`;
                }

                await sock.sendMessage(sender, { text: helpText }, { quoted: msg });
                return;
            }

            // WHOAMI
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

            // FUN & MOTIVATION
            if (textLower === 'motivate me' || textLower === 'daily quote' || textLower === 'inspire me') {
                const quotes = [
                    "Success is not final, failure is not fatal: it is the courage to continue that counts. - Winston Churchill",
                    "Don't watch the clock; do what it does. Keep going. - Sam Levenson",
                    "The secret of getting ahead is getting started. - Mark Twain",
                    "It always seems impossible until it's done. - Nelson Mandela",
                    "Bestie, just focus on your goals. No cap, you got this! 🔥"
                ];
                const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
                await sock.sendMessage(sender, { text: `✨ *Motivation:*\n\n"${randomQuote}"` }, { quoted: msg });
                return;
            }
            
            // RIDDLE
            if (textLower === 'riddle') {
                global.currentRiddle = "I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?";
                await sock.sendMessage(sender, { text: `🧩 *Riddle:*\n\n${global.currentRiddle}` }, { quoted: msg });
                return;
            }
            if (textLower === 'answer' && global.currentRiddle) {
                await sock.sendMessage(sender, { text: "✅ The answer is: **An Echo**! 🎉" }, { quoted: msg });
                global.currentRiddle = null;
                return;
            }

            // ACADEMIC WORD PRACTICE
            if (textLower === 'word' || textLower === 'aw word' || textLower === 'practice word' || textLower === 'vocabulary') {
                const wordKeys = Object.keys(academicWords);
                const randomWord = wordKeys[Math.floor(Math.random() * wordKeys.length)];
                const wordMeaning = academicWords[randomWord];
                await sock.sendMessage(sender, { text: `📚 *Academic Word Practice*\n\n*${randomWord}*\n📖 Meaning: ${wordMeaning}\n\nType *word* again to get another one! 🔄` }, { quoted: msg });
                return;
            }

            // THANKS AUTO-REPLY
            if (textLower.includes('thanks') || textLower.includes('thank you') || textLower.includes('sthuthi') || textLower.includes('stuti') || textLower.includes('bohoma sthuthi')) {
                await sock.sendMessage(sender, { text: "ඔයාව සාදරයෙන් පිළිගන්නවා! 🥰❤️ තව මොනවා හරි ඕන නම් අහන්න!" }, { quoted: msg });
                return;
            }

            // GENERAL AI RESPONSE (with memory + JARVIS-style)
            if (rawMessageText) {
                try {
                    const history = getRecentContext(sender);
                    let promptToSend = fullUserPrompt;
                    
                    if (history) {
                        promptToSend = `Recent conversation with this student:\n${history}\n\nNew message from student: "${fullUserPrompt}"\n\nReply naturally and helpfully. If the batch rep's memory has relevant info, use it confidently as if you already know it.`;
                    }
                    
                    geminiRequestsToday++;
                    const result = await generateContentWithRetry(model, buildPromptWithKnowledge(promptToSend));
                    const reply = formatMathForWhatsApp(result.response.text());
                    addToMemory(sender, 'User', fullUserPrompt);
                    addToMemory(sender, 'Bot', reply);
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                } catch (error) {
                    console.error('Gemini error:', error);
                    
                    let errorMessage = "❌ සමාවෙන්න, මට දැන් උත්තර දෙන්න බැරි වුණා. ";
                    
                    if (error.message.includes('503') || error.message.includes('429')) {
                        errorMessage += "API එක busy. ටික වේලාවකින් නැවත try කරන්න. ⏳";
                    } else if (error.message.includes('content') || error.message.includes('filter')) {
                        errorMessage += "ඔබගේ ප්‍රශ්නයට උත්තර දෙන්න මට ඉඩ නැහැ. වෙනත් ප්‍රශ්නයක් අහන්න. 🙏";
                    } else if (error.message.includes('API key')) {
                        errorMessage += "API Key එක invalid. Admin ට දැනුම් දෙන්න. 🛠️";
                    } else {
                        errorMessage += "නැවත try කරන්න. 🔄";
                    }
                    
                    await sock.sendMessage(sender, { text: errorMessage }, { quoted: msg });
                }
            }
        }

        // ----------------------------------------------------------------
        //  messages.upsert
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
