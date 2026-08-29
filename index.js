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

// "whoami" command eken labena EXACT JID string eka methanata add karanna —
// self-chat, multi-device, LID mismatch wage cases walata mekamai reliable
// fix eka. Example: ADMIN_JIDS = ["94762513957@s.whatsapp.net"]
const ADMIN_JIDS = [];

// ======================================================================
// 📚 CUSTOM KNOWLEDGE BASE (persistent, file-backed)
// Admin (Monal) dena info tika methanata save wenawa (knowledge.json file
// ekata), server restart unath persist wenawa. Student kenek questions
// ahuwwama, mek info tika Gemini ta context ekak widiyata dila answer
// karanna use karanawa.
// ======================================================================
const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge.json');
let knowledgeBase = [];

try {
    if (fs.existsSync(KNOWLEDGE_FILE)) {
        knowledgeBase = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
    }
} catch (err) {
    console.error('Error loading knowledge.json, starting with empty knowledge base:', err);
    knowledgeBase = [];
}

function saveKnowledgeBase() {
    try {
        fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledgeBase, null, 2));
    } catch (err) {
        console.error('Error saving knowledge.json:', err);
    }
}

// Gemini ekata yawana ANY prompt ekakata (text/image/pdf/audio) mek helper
// eken saved knowledge base eka context widiyata add karanawa.
function buildPromptWithKnowledge(basePrompt) {
    if (knowledgeBase.length === 0) return basePrompt;
    const knowledgeText = knowledgeBase.map((k, i) => `${i + 1}. ${k}`).join('\n');
    return `${basePrompt}\n\n[BATCH-SPECIFIC KNOWLEDGE — Batch Rep (Monal) saved this info. If it's relevant to the user's question, prioritize using it over general knowledge:]\n${knowledgeText}`;
}

// ======================================================================
// 📁 FILE REGISTRY (persistent, keyword-triggered document delivery)
// Admin PDF/document ekak "add file: <keyword>" caption ekakin upload
// karanawa. File eka disk ekata save wela, keyword eka registry ekata
// (files-registry.json) danawa. Student kenek text message ekaka ee
// keyword eka type kalot, bot eken ema file eka automatic-ma yawanawa.
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
    console.error('Error loading files-registry.json, starting with empty file registry:', err);
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
// 📇 STUDENT REGISTRY (self-declared name + phone, persistent)
// WhatsApp ge LID system eken JID ekakin real phone number ekak
// reliably-ma reverse-resolve karanna beri nisa (WhatsApp official
// documentation eken confirm wena privacy restriction ekak — bug ekak
// nemei), student ma "register: <name>, <number>" kiyala danna
// self-declared data ekak use karanawa. Meka JID format ekata
// (LID/phone) depend wenne na — student kenek karanne ekawarak witharai.
// ======================================================================
const STUDENTS_FILE = path.join(__dirname, 'students.json');
let studentRegistry = {}; // key: sender JID, value: { name, phone, registeredAt }

try {
    if (fs.existsSync(STUDENTS_FILE)) {
        studentRegistry = JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8'));
    }
} catch (err) {
    console.error('Error loading students.json, starting empty:', err);
    studentRegistry = {};
}

function saveStudentRegistry() {
    try {
        fs.writeFileSync(STUDENTS_FILE, JSON.stringify(studentRegistry, null, 2));
    } catch (err) {
        console.error('Error saving students.json:', err);
    }
}

// ======================================================================
// 🔄 LAB GROUP SWAP MATCHER (persistent, mutual-swap request matching)
// Student kenek "swap: 1 to 2" wage message ekak DM ekaka danawa (current
// group 1, wants group 2). Bot eka registry ekata (swap-requests.json) save
// karala, exact opposite direction ekata (2 -> 1) ahuwapu kenek dannawa nam,
// dennatama automatic-ma "match hambuna" notification ekak yawanawa —
// official Google Form eka dennenma-ekata submit karanna kiyala.
// ======================================================================
const SWAP_REQUESTS_FILE = path.join(__dirname, 'swap-requests.json');
let swapRequests = {}; // key: sender JID, value: { fromGroup, toGroup, rawFrom, rawTo, name, timestamp, matched, matchedWith }

try {
    if (fs.existsSync(SWAP_REQUESTS_FILE)) {
        swapRequests = JSON.parse(fs.readFileSync(SWAP_REQUESTS_FILE, 'utf8'));
    }
} catch (err) {
    console.error('Error loading swap-requests.json, starting empty:', err);
    swapRequests = {};
}

function saveSwapRequests() {
    try {
        fs.writeFileSync(SWAP_REQUESTS_FILE, JSON.stringify(swapRequests, null, 2));
    } catch (err) {
        console.error('Error saving swap-requests.json:', err);
    }
}

// "Group 1", "group1", "1" — okkoma "1" widiyata normalize karanawa, compare karanna ledi wenna
function normalizeGroupLabel(raw) {
    return raw.toLowerCase().replace(/group|grp|lab/gi, '').trim();
}

// JID ekakin phone number eka (thiyenawa nam) extract karala pennanna.
// @s.whatsapp.net = real, dialable phone number.
// @lid = WhatsApp ge privacy ID (phone number number ekak nemei — dial karanna barinawa),
// mekata "+" dala phone number ekak widiyata penvuwoth misleading wenawa.
function extractPhoneDisplay(jid) {
    const normalized = jidNormalizedUser(jid) || jid;
    if (normalized.endsWith('@s.whatsapp.net')) {
        const match = normalized.match(/^(\d+)@/);
        return match ? `+${match[1]}` : normalized;
    }
    // @lid account ekak — real phone number ekak denna behe
    return null;
}

// ======================================================================
// 🧵 CONCURRENCY QUEUE
// Godak students ekaparata message dammoth, siyaluma Gemini/ffmpeg calls
// ekawaraama fire wenawa nam, API rate limits වදින්න, ffmpeg processes
// ගොඩගැහෙන්න, RAM/CPU spike එකකින් bot එක crash වෙන්නත් පුළුවන්.
// මේ queue එකෙන් එකවර process වෙන message ගණන limit කරනවා (MAX_CONCURRENT),
// ඉතුරු ඒවා queue එකේ රැඳිලා, එකින් එක slot එකක් available වෙනකොට process වෙනවා.
// ======================================================================
const MAX_CONCURRENT = 3; // Test කරලා ඔයාගේ server/API quota එකට ගැලපෙන ලෙස වෙනස් කරන්න

class ConcurrencyQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    // onQueued(position) is called ONLY when the task cannot start immediately
    // (i.e. all MAX_CONCURRENT slots are busy) — position is this task's place
    // in line (1 = next up). Use it to tell the sender "please wait".
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
        task()
            .then(resolve)
            .catch(reject)
            .finally(() => {
                this.running--;
                this._next();
            });
    }
}

const messageQueue = new ConcurrencyQueue(MAX_CONCURRENT);

// ======================================================================
// 🔁 MESSAGE DEDUP
// Baileys reconnect වෙනකොට sometimes same message event දෙපාරක් fire
// වෙන්න පුළුවන් (network hiccup, resync). මේ Set එකෙන් message.id track
// කරලා, දැනටමත් process කරපු message එකක් ආයෙත් process කරන එක නවත්තනවා.
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
// 🔒 ADMIN CHECK (safer version)
// Original code eke `sender.includes(...)` කියන්නේ substring match එකක්.
// Practically risk අඩුයි, ඒත් jidNormalizedUser() එකෙන් JID එක normalize
// කරලා exact compare කරන එකයි Baileys ගේ recommended approach එක.
// ⚠️ Test කරලා බලන්න: ඔයාගේ Baileys version එකේ LID JIDs ලියෙන්නේ
// "<lid>@lid" විදිහටද කියලා. එහෙම නැත්නම් suffix එක වෙනස් කරන්න.
// ======================================================================
function isSenderAdmin(sender) {
    const normalized = jidNormalizedUser(sender) || sender;
    if (ADMIN_JIDS.includes(sender) || ADMIN_JIDS.includes(normalized)) return true;
    const isPhoneMatch = normalized === `${ADMIN_PHONE_NUMBER}@s.whatsapp.net`;
    const isLidMatch = ADMIN_LID && (normalized === `${ADMIN_LID}@lid` || sender.includes(ADMIN_LID));
    return isPhoneMatch || isLidMatch || sender.includes(ADMIN_PHONE_NUMBER);
}

// ======================================================================
// 📅 GOOGLE CALENDAR API SETUP
// Students ta "today classes" / "next class" / "check date ..." wage live
// commands denna, Google Calendar API eka use karanawa. Env vars 3ma
// (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN) set karala
// nathnam, mek commands walata error ekak witharai denne — bot eke anith
// features walata (Gemini Q&A, swap matcher wagerta) balapaanne na.
// ======================================================================
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.warn('⚠️ Google Calendar env vars set karala na — calendar commands wada karanne na, ethakota anith features walata pravasha na.');
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

// Express Web Server Setup
const app = express();
const PORT = process.env.PORT || 3000;
let latestQR = "";
let isConnected = false; // "connection === 'open'" welawe true wenawa

app.get('/', async (req, res) => {
    // Bot eka dæn connect wela nam, static "Connected" page ekak denna —
    // meka auto-refresh ekak natha, ehema natnam browser tab ekak open
    // wela hitiyoth, thatpara 3kata parak forever server ekata hit karanawa
    // (memory/CPU walata unnecessary load ekak, restart loop ekakatath
    // conducive wenna puluwan).
    if (isConnected) {
        return res.send(`
            <html>
                <head><title>HansanaBot — Connected</title></head>
                <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
                    <h2>✅ Bot එක Connected & Running!</h2>
                </body>
            </html>
        `);
    }
    if (!latestQR) {
        return res.send(`
            <html>
                <head><meta http-equiv="refresh" content="3"></head>
                <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
                    <h2>QR Code එක Loading... තත්පර 3න් Auto Refresh වෙයි...</h2>
                </body>
            </html>
        `);
    }
    try {
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`
            <html>
                <head><title>WhatsApp Bot QR Code</title><meta http-equiv="refresh" content="5"></head>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
                    <h2>Scan this QR Code with WhatsApp</h2>
                    <img src="${qrImage}" style="border:10px solid white;border-radius:10px;width:300px;height:300px;"/>
                </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR code');
    }
});

app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
});

// Gemini API Setup
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY environment variable eka set karala nathnam bot ekata Gemini call ganna barinawa. Process eka nawaththanawa.');
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

CRITICAL — NO LATEX, USE UNICODE MATH SYMBOLS DIRECTLY:
- WhatsApp text messages CANNOT render LaTeX or markdown math syntax. NEVER write things like $\cup$, \cap, \in, $$...$$, \( \), or \frac{a}{b} — these show up as broken literal text to the student.
- Instead, always use the actual Unicode symbol directly in plain text: ∪ (union), ∩ (intersection), ∈ (element of), ∉ (not element of), ⊂ (subset), ⊆ (subset or equal), ⊃, ⊇, ∅ (empty set), ∀ (for all), ∃ (there exists), ≤, ≥, ≠, ≈, × , ÷, ±, √, π, ∞, → , ⇒, ⇔, Σ, ∑, ∫, ², ³, and Greek letters (α, β, θ, etc.) written directly.
- For fractions, write "a/b" or "a ÷ b" in plain text instead of \frac{a}{b}.

CRITICAL CODE & TUTORIAL ANALYSIS RULES:
- When analyzing code snippets or tutorials:
  1. Pay EXTREME attention to variable scope and re-initialization (e.g., whether 'j = 1' is initialized OUTSIDE or INSIDE an outer loop).
  2. Distinguish clearly between Sequential/Consecutive loops and Nested loops. Do not multiply iterations unless one loop is strictly nested inside another.
  3. Keep track of accurate question labeling (a, b, c, d, e) without swapping their code contents.
`;

// Safety net: Gemini's system instruction tells it to avoid LaTeX, but if it
// slips into LaTeX anyway (models sometimes do), this converts the common
// math commands to Unicode symbols before the reply reaches WhatsApp — so
// the student never sees broken "$\cup$" style text.
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

// convertAudioToWav actually converts to mp3 (kept name for compatibility with earlier code).
// Uses crypto.randomUUID() now instead of Date.now() so two students sending voice notes
// at the exact same millisecond never collide on the same temp filename.
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
                } catch (e) {
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

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        badSessionDeleteHistory: true,
        retryRequestDelayMs: 2000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            // Reconnect welawe, mek dead socket ekata connect wela hitiya
            // listeners tika explicitly ain karanawa — natnam, WebSocket
            // ekak pass wela message ekak wenas welath, purana listeners
            // walata reference tika process eke hitiya welawa purama
            // memory ekata rendi wela, gradual leak ekakata pathwenna puluwan.
            sock.ev.removeAllListeners();
            if (shouldReconnect) {
                connectToWhatsApp();
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

    // ------------------------------------------------------------------
    // 🧠 Actual per-message processing logic (unchanged behaviour),
    // now wrapped as a standalone function so it can be handed to the
    // concurrency queue instead of running unbounded in a tight loop.
    // ------------------------------------------------------------------
    async function processMessage(sock, msg) {
        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');

        // Bot eka DM Q&A witharayi wada karanne — group message ekakata
        // kisisethakma respond wenne na (announcement/general group check
        // ain kara, siyalu groups ma skip wenawa).
        if (isGroup) return;

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

        let fullUserPrompt = rawMessageText;
        if (quotedText) {
            fullUserPrompt = `[Quoted/Referenced Text: "${quotedText}"]\nUser Action Requested: "${rawMessageText}"`;
        }

        if (audioMsg) {
            try {
                await sock.sendMessage(sender, { text: "🎙️ **Voice Note එක Process වෙමින් පවතියි...**" }, { quoted: msg });
                const oggBuffer = await downloadMediaMessage(msg, 'buffer', {});
                const mp3Buffer = await convertAudioToWav(oggBuffer);
                const base64Audio = mp3Buffer.toString('base64');
                const audioPart = { inlineData: { data: base64Audio, mimeType: 'audio/mp3' } };
                const prompt = buildPromptWithKnowledge("Listen carefully to this audio message. Reply clearly in friendly Singlish or Sinhala/English.");
                const result = await model.generateContent([prompt, audioPart]);
                const reply = formatMathForWhatsApp(result.response.text());
                await sock.sendMessage(sender, { text: reply }, { quoted: msg });
            } catch (err) {
                console.error('Error processing Audio:', err);
                await sock.sendMessage(sender, { text: "❌ Voice Message එක තේරුම් ගන්න බැරි වුණා." }, { quoted: msg });
            }
            return;
        }

        if (docMsg) {
            // 📁 ADD FILE (admin only, DM only): "add file: <keyword>" caption
            // ekakin document upload karanawa nam, Gemini analyze karanne nathuwa,
            // file eka disk ekata save karala, keyword eka registry ekata danawa.
            if (!isGroup && /^add file\b/i.test(rawMessageText.toLowerCase().trim())) {
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { text: "❌ මචං, File Add කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                const keyword = rawMessageText.replace(/^add file\s*:?\s*/i, '').trim().toLowerCase();
                if (!keyword) {
                    await sock.sendMessage(sender, { text: `⚠️ මචං, keyword එකත් caption එකේ දෙන්න — e.g. "add file: course outline IT1170"` }, { quoted: msg });
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

                    await sock.sendMessage(sender, { text: `✅ File එක save කළා! Keyword: "${keyword}"\n\nදැන් student කෙනෙක් "${keyword}" කියලා type කළොත් bot එකෙන් මේ file එකම automatic ලෙස එවනවා.` }, { quoted: msg });
                } catch (err) {
                    console.error('Error saving file to registry:', err);
                    await sock.sendMessage(sender, { text: "❌ File එක save කිරීමේදී Error එකක් ආවා." }, { quoted: msg });
                }
                return;
            }

            // 🔍 Normal PDF analysis (Gemini reads/explains the PDF)
            try {
                const mimeType = docMsg?.mimetype || '';
                if (mimeType === 'application/pdf') {
                    await sock.sendMessage(sender, { text: "📄 **PDF Document එක Read කරමින් පවතියි...** පොඩ්ඩක් ඉන්න!" }, { quoted: msg });
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const base64Pdf = buffer.toString('base64');
                    const pdfPart = { inlineData: { data: base64Pdf, mimeType: 'application/pdf' } };
                    const captionPrompt = rawMessageText ? ` User instructions: "${rawMessageText}"` : "";
                    const prompt = buildPromptWithKnowledge("Read this PDF document carefully and fulfill the user request in clear Singlish or simple English." + captionPrompt);
                    const result = await model.generateContent([prompt, pdfPart]);
                    const reply = formatMathForWhatsApp(result.response.text());
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                }
            } catch (err) {
                console.error('Error processing PDF Document:', err);
                await sock.sendMessage(sender, { text: "❌ PDF එක Read කරගන්න බැරි වුණා." }, { quoted: msg });
            }
            return;
        }

        if (imgMsg) {
            // 🔍 Normal image analysis (Gemini reads/explains the image)
            try {
                await sock.sendMessage(sender, { text: "⏳ **Image එක Processing...**" }, { quoted: msg });
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const base64Image = buffer.toString('base64');
                const mimeType = imgMsg.mimetype || 'image/jpeg';
                const imagePart = { inlineData: { data: base64Image, mimeType: mimeType } };
                const captionPrompt = rawMessageText ? ` User instructions: "${rawMessageText}"` : "";
                const prompt = buildPromptWithKnowledge("Read all details in this screenshot/image. If requested, generate a clean and formatted announcement notice or answer the user's question clearly in simple English or Singlish." + captionPrompt);
                const result = await model.generateContent([prompt, imagePart]);
                const reply = formatMathForWhatsApp(result.response.text());
                await sock.sendMessage(sender, { text: reply }, { quoted: msg });
            } catch (err) {
                console.error('Error processing Image:', err);
                await sock.sendMessage(sender, { text: "❌ Image එක කියවගන්න බැරි වුණා. කරුණාකර නැවත එවා බලන්න." }, { quoted: msg });
            }
            return;
        }

        if (!isGroup) {
            const textLower = rawMessageText.toLowerCase().trim();

            // 👋 FRIENDLY IDENTITY CHECK: "who am i" / "man kauda" wage
            // natural language ekakin ahuwwama, technical JID ekak nathuwa,
            // "ඔයා Batch Rep" kiyala friendly confirmation ekak denawa.
            const isWhoAmIQuestion = /\bwho\s*am\s*i\b/i.test(textLower)
                || textLower.includes('man kauda') || textLower.includes('mn kauda') || textLower.includes('mama kauda')
                || rawMessageText.includes('මං කවුද') || rawMessageText.includes('මම කවුද');

            if (isWhoAmIQuestion) {
                const isAdmin = isSenderAdmin(sender);
                if (isAdmin) {
                    await sock.sendMessage(
                        sender,
                        { text: `👋 ඔයා තමයි *Monal Hansana* — SLIIT IT Y1S2 Batch Representative! ✅\n\nGroup එකට Announcements/Images/Documents post කරන්න පුළුවන් permission ඔයාට තියෙනවා.` },
                        { quoted: msg }
                    );
                } else {
                    await sock.sendMessage(
                        sender,
                        { text: `👤 ඔයා දැනට bot එකේ Batch Rep කෙනෙක් විදිහට recognize වෙන්නෙ නෑ — student/other user කෙනෙක් විදිහට තමයි recognize වෙන්නේ.` },
                        { quoted: msg }
                    );
                }
                return;
            }

            // 🆔 SELF-DIAGNOSTIC: "whoami" type kalata, ohage exact JID eka
            // (raw + normalized) reply karanawa. Admin check eka pass wenne
            // nathnam, mekedi labena JID eka copy karala ADMIN_JIDS array
            // ekata danna — eka thamai ekma-100%-wada karana fix eka.
            if (textLower === 'whoami' || textLower === 'my id' || textLower === 'myid') {
                const normalized = jidNormalizedUser(sender) || sender;
                await sock.sendMessage(
                    sender,
                    { text: `🆔 *ඔයාගේ WhatsApp ID*\n\nRaw: \`${sender}\`\nNormalized: \`${normalized}\`\n\nMe eka ADMIN_JIDS array ekata danna admin access denna.` },
                    { quoted: msg }
                );
                return;
            }

            // 📅 TODAY'S CLASSES (open to all — live Google Calendar data)
            if (textLower === 'today classes' || textLower === 'today timetable' || textLower === 'today schedule' || textLower === 'today') {
                const events = await getTodaysEvents();
                if (events.length === 0) {
                    await sock.sendMessage(sender, { text: `📅 *Today's Schedule*\n\n🎉 No classes scheduled for today! Enjoy your day!` }, { quoted: msg });
                } else {
                    let message = `📅 *Today's Classes - ${formatDateDisplay(new Date().toISOString())}*\n\n`;
                    events.forEach((event, i) => {
                        const time = event.start.dateTime ? formatEventTime(event.start.dateTime) : 'All day';
                        const location = event.location ? `📍 ${event.location}` : '';
                        message += `${i + 1}. *${event.summary}*\n   🕐 ${time}\n`;
                        if (location) message += `   ${location}\n`;
                        message += '\n';
                    });
                    await sock.sendMessage(sender, { text: message }, { quoted: msg });
                }
                return;
            }

            // 📅 NEXT CLASS (open to all — live Google Calendar data)
            if (textLower === 'next class' || textLower === 'next lecture' || textLower === 'next') {
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
                return;
            }

            // 📅 CHECK SPECIFIC DATE (open to all — live Google Calendar data)
            const dateMatch = rawMessageText.match(/^check date\s+(\d{4}-\d{2}-\d{2})$/i);
            if (dateMatch) {
                const dateStr = dateMatch[1];
                const events = await getEventsForDate(dateStr);
                if (events === null) {
                    await sock.sendMessage(sender, { text: `⚠️ Invalid date format. Use: \`check date YYYY-MM-DD\`\nExample: \`check date 2026-09-01\`` }, { quoted: msg });
                } else if (events.length === 0) {
                    await sock.sendMessage(sender, { text: `📅 *Schedule for ${formatDateDisplay(dateStr)}*\n\n🎉 No classes on this day!` }, { quoted: msg });
                } else {
                    let message = `📅 *Schedule for ${formatDateDisplay(dateStr)}*\n\n`;
                    events.forEach((event, i) => {
                        const time = event.start.dateTime ? formatEventTime(event.start.dateTime) : 'All day';
                        message += `${i + 1}. *${event.summary}*\n   🕐 ${time}\n\n`;
                    });
                    await sock.sendMessage(sender, { text: message }, { quoted: msg });
                }
                return;
            }

            // 📅 CALENDAR / TIMETABLE SUBSCRIPTION LINK (ICS)
            if (textLower === 'calendar' || textLower === 'timetable' || textLower === 'time table' || textLower === 'time' || textLower === 'calender') {
                await sock.sendMessage(sender, {
                    text: `📅 *SLIIT Timetable එක ඔබගේ Phone එකට Add කරගන්න*

🔗 *පහත Link එක Click කරන්න:*
https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t

---

📌 *ඊළඟ පියවර (වැදගත්):*
1. Link එක Open කරලා *"Add" / "Subscribe"* කරන්න.
2. ඔබගේ *Google Calendar App* එක Open කරන්න.
3. ඉහළ වම් කොනේ *☰ (Menu)* එක ඔබන්න.
4. පහළට ගිහින් *"Other calendars"* එක බලන්න.
5. එතන *"SLIIT Timetable"* එකට *✔️ Tick* එකක් දාන්න!

✨ *ඉවරයි!* දැන් ඔබගේ Calendar එකේ Timetable එක පෙන්වයි.

⚠️ *පෙන්නන්නේ නැත්නම්:* ඉහත *"Other calendars"* එක Check කරලා Auto-Sync ON කරන්න.

💡 *Tip:* "today classes", "next class", හෝ "check date 2026-09-01" කියලා type කළොත් bot එකෙන්ම කෙලින්ම schedule එක කියයි!`
                }, { quoted: msg });
                return;
            }

            // 📅 CALENDAR TROUBLESHOOTING
            if (textLower === 'calendar help' || textLower === 'calendar not showing' || textLower === 'sync calendar') {
                await sock.sendMessage(sender, {
                    text: `📅 *Calendar Troubleshooting Guide*

🔗 *Link:*
https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t

---

*✅ Step 1: Check if added*
• Open Google Calendar App
• Tap ☰ (Menu)
• Look for "SLIIT Timetable" under "Other calendars"
• If there, make sure it's ✅ CHECKED

*✅ Step 2: Correct Google Account*
• Settings → Calendar → Accounts → Google
• Make sure your SLIIT email is there
• Toggle ON "Calendars" for that account

*✅ Step 3: Auto-Sync ON*
• Settings → Accounts → Google
• Select your SLIIT account
• Toggle ON "Calendar" sync

*✅ Step 4: Remove & Re-add*
• Unsubscribe from the calendar
• Click the link above again
• Re-subscribe

📱 *Still not working?* Contact Batch Rep: +94 76 251 3957`
                }, { quoted: msg });
                return;
            }

            // 📇 STUDENT REGISTER (open to ALL students, DM only): "register:
            // name, number" kiyala ekawarak type karanawa. Mek self-declared
            // number eka, WhatsApp LID system eken reliably resolve karanna
            // beri phone numbers walata fallback ekak widiyata swap match
            // notifications walata use wenawa.
            const registerMatch = rawMessageText.match(/^register\s*:?\s*(.+?)\s*,\s*(.+)$/i);
            if (registerMatch) {
                const studentName = registerMatch[1].trim();
                const studentPhone = registerMatch[2].trim().replace(/[^\d+]/g, '');
                if (!studentName || !studentPhone) {
                    await sock.sendMessage(sender, { text: `⚠️ Format එක: "register: Kasun Perera, 0771234567" වගේ දෙන්න.` }, { quoted: msg });
                    return;
                }
                studentRegistry[sender] = { name: studentName, phone: studentPhone, registeredAt: Date.now() };
                saveStudentRegistry();
                await sock.sendMessage(sender, { text: `✅ Register වුනා: *${studentName}* (${studentPhone})\n\nදැන් swap match වුනොත්, මේ number එකම අනිත් student ට යනවා.` }, { quoted: msg });
                return;
            }

            // 🔄 LAB GROUP SWAP REQUEST (open to ALL students, DM only):
            // "swap: 1 to 2" wage format ekakin, current group eka (1) saha
            // wenna ona group eka (2) record karanawa. Exact opposite
            // direction ekata ahuwapu kenek dannawa nam, dennatama match
            // notification ekak yawanawa.
            const swapMatch = rawMessageText.match(/^swap\s*:?\s*(.+?)\s+(?:to|->|dakwa)\s+(.+)$/i);
            if (swapMatch) {
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

                    // Priority: 1) self-declared registered number (100% reliable,
                    // JID format eken independent), 2) real phone-JID extraction
                    // (@s.whatsapp.net witharai), 3) fallback — group eke name eken
                    // hoyaganna kiyanawa.
                    const myRegistered = studentRegistry[sender];
                    const otherRegistered = studentRegistry[matchedJid];
                    const myPhone = myRegistered?.phone || extractPhoneDisplay(sender);
                    const otherPhone = otherRegistered?.phone || extractPhoneDisplay(matchedJid);

                    const otherContactLine = otherPhone
                        ? `Contact: ${otherPhone}`
                        : `Contact: group chat eke *${matchedReq.name}* kiyala hoyaganna (direct phone number ekak denna baha).`;
                    const myContactLine = myPhone
                        ? `Contact: ${myPhone}`
                        : `Contact: group chat eke *${swapRequests[sender].name}* kiyala hoyaganna (direct phone number ekak denna baha).`;

                    await sock.sendMessage(
                        sender,
                        { text: `🎉 Match හම්බුනා! *${matchedReq.name}* ට ඔයාට ${matchedReq.rawFrom} → ${matchedReq.rawTo} (opposite direction) swap කරන්න ඕන.\n${otherContactLine}\n\nඑයාව contact කරලා, "Lab Group Change Request Form" එකට **එක කෙනෙක් විතරක්** fill කරලා Friday 28 Aug 11:59 AM ට කලින් submit කරන්න! ✅` },
                        { quoted: msg }
                    );
                    await sock.sendMessage(matchedJid, {
                        text: `🎉 Match හම්බුනා! *${swapRequests[sender].name}* ට ඔයාට ${rawFrom} → ${rawTo} (opposite direction) swap කරන්න ඕන.\n${myContactLine}\n\nඑයාව contact කරලා, "Lab Group Change Request Form" එකට **එක කෙනෙක් විතරක්** fill කරලා Friday 28 Aug 11:59 AM ට කලින් submit කරන්න! ✅`
                    });
                } else {
                    saveSwapRequests();
                    await sock.sendMessage(
                        sender,
                        { text: `✅ Request save කළා: Group ${rawFrom} → Group ${rawTo}.\n\nඅනිත් direction එකේ (Group ${rawTo} → Group ${rawFrom}) swap ඕන කෙනෙක් register වුනු ගමන්, ඔයාට automatic ලෙස notify කරන්නම්! 🔔` },
                        { quoted: msg }
                    );
                }
                return;
            }

            // 📋 LIST SWAPS (admin only) — pending/matched requests okkoma balanna
            if (textLower === 'list swaps' || textLower === 'show swaps') {
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { text: "❌ මචං, මේක බලන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                const entries = Object.entries(swapRequests);
                if (entries.length === 0) {
                    await sock.sendMessage(sender, { text: "📭 දැනට swap requests නෑ." }, { quoted: msg });
                } else {
                    const list = entries
                        .map(([jid, req], i) => `${i + 1}. ${req.name} (${extractPhoneDisplay(jid) || 'No phone — LID account'}): ${req.rawFrom} → ${req.rawTo} ${req.matched ? '✅ Matched' : '⏳ Waiting'}`)
                        .join('\n');
                    await sock.sendMessage(sender, { text: `🔄 *Swap Requests (${entries.length})*\n\n${list}` }, { quoted: msg });
                }
                return;
            }

            // 🗑️ CLEAR SWAPS (admin only) — registration period eka iwara unama reset karanna
            if (textLower === 'clear swaps') {
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { text: "❌ මචං, මේක කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                swapRequests = {};
                saveSwapRequests();
                await sock.sendMessage(sender, { text: "🗑️ Swap requests ඔක්කොම clear කළා." }, { quoted: msg });
                return;
            }

            // 📇 LIST STUDENTS (admin only) — kavda register wela kiyala check karanna
            if (textLower === 'list students') {
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { text: "❌ මචං, මේක බලන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                const entries = Object.values(studentRegistry);
                if (entries.length === 0) {
                    await sock.sendMessage(sender, { text: "📭 කවුරුවත් register වෙලා නෑ තාම." }, { quoted: msg });
                } else {
                    const list = entries.map((s, i) => `${i + 1}. ${s.name} — ${s.phone}`).join('\n');
                    await sock.sendMessage(sender, { text: `📇 *Registered Students (${entries.length})*\n\n${list}` }, { quoted: msg });
                }
                return;
            }

            // 📚 ADD INFO (admin only, DM only): "add info: <text>" wage command
            // ekakin, Monal denna info eka knowledge.json ekata permanently save
            // wenawa. Students ahuwwama, mek info eka Gemini ta context ekak
            // widiyata dila answer karanna use karanawa (buildPromptWithKnowledge).
            if (/^(add info|info add|save info)\b/i.test(textLower)) {
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { text: "❌ මචං, Info Add කරන්න පුළුවන් Batch Rep (Monal) ට විතරයි!" }, { quoted: msg });
                    return;
                }
                const infoText = rawMessageText.replace(/^(add info|info add|save info)\s*:?\s*/i, '').trim();
                if (!infoText) {
                    await sock.sendMessage(sender, { text: `⚠️ මචං, info text එකත් එක්කම type කරන්න — e.g.\n"add info: Mid exam eka postpone una, aluth date eka Sept 15"` }, { quoted: msg });
                    return;
                }
                knowledgeBase.push(infoText);
                saveKnowledgeBase();
                await sock.sendMessage(sender, { text: `✅ Info එක save කළා! (Total: ${knowledgeBase.length})\n\nදැන් students ඇහුවොත් bot එකෙන් මේක use කරලා answer කරයි.` }, { quoted: msg });
                return;
            }

            // 📋 LIST INFO (admin only) — saved info tika review karanna
            if (textLower === 'list info' || textLower === 'show info') {
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { text: "❌ මචං, මේක බලන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                if (knowledgeBase.length === 0) {
                    await sock.sendMessage(sender, { text: "📭 දැනට info මොකවත් save කරලා නෑ." }, { quoted: msg });
                } else {
                    const list = knowledgeBase.map((k, i) => `${i + 1}. ${k}`).join('\n\n');
                    await sock.sendMessage(sender, { text: `📚 *Saved Info (${knowledgeBase.length})*\n\n${list}` }, { quoted: msg });
                }
                return;
            }

            // 🗑️ REMOVE INFO (admin only) — "remove info 2" wage number ekakin
            if (/^remove info\s+\d+/i.test(textLower)) {
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { text: "❌ මචං, මේක කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
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
                return;
            }

            // 📋 LIST FILES (admin only) — saved files tika keyword ekath ekka review karanna
            if (textLower === 'list files' || textLower === 'show files') {
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { text: "❌ මචං, මේක බලන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                if (fileRegistry.length === 0) {
                    await sock.sendMessage(sender, { text: "📭 දැනට files මොකවත් save කරලා නෑ." }, { quoted: msg });
                } else {
                    const list = fileRegistry.map((f, i) => `${i + 1}. "${f.keyword}" → ${f.fileName}`).join('\n');
                    await sock.sendMessage(sender, { text: `📁 *Saved Files (${fileRegistry.length})*\n\n${list}` }, { quoted: msg });
                }
                return;
            }

            // 🗑️ REMOVE FILE (admin only) — "remove file 2" wage number ekakin (list files order eken)
            if (/^remove file\s+\d+/i.test(textLower)) {
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { text: "❌ මචං, මේක කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
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
                } catch (e) {
                    console.error('Error deleting stored file from disk:', e);
                }
                await sock.sendMessage(sender, { text: `🗑️ ඉවත් කළා: "${removedFile.keyword}" (${removedFile.fileName})` }, { quoted: msg });
                return;
            }

            // 📤 FILE DELIVERY (any user — students included): message eke
            // registered keyword ekak substring ekak widiyata thiyenawa nam,
            // ema file eka automatic-ma yawanawa (Gemini call ekak nathuwa).
            const matchedFile = fileRegistry.find((f) => textLower.includes(f.keyword));
            if (matchedFile) {
                try {
                    const buffer = fs.readFileSync(path.join(FILES_DIR, matchedFile.storedFileName));
                    await sock.sendMessage(
                        sender,
                        { document: buffer, mimetype: matchedFile.mimetype, fileName: matchedFile.fileName },
                        { quoted: msg }
                    );
                } catch (err) {
                    console.error('Error sending matched file:', err);
                    await sock.sendMessage(sender, { text: "❌ File එක එවීමේදී Error එකක් ආවා." }, { quoted: msg });
                }
                return;
            }

            if (rawMessageText) {
                try {
                    const result = await model.generateContent(buildPromptWithKnowledge(fullUserPrompt));
                    const replyText = formatMathForWhatsApp(result.response.text());
                    await sock.sendMessage(sender, { text: replyText }, { quoted: msg });
                } catch (error) {
                    console.error('Error generating AI response:', error);
                }
            }
        }
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            // Dedup: monawahari duplicate event ekak nam skip karanawa
            if (processedMessages.has(msg.key.id)) continue;
            markProcessed(msg.key.id);

            // Godak students ekaparata message dammoth, wada eka queue ekakata
            // dala, MAX_CONCURRENT ekata adu wenna process karanawa.
            // Ekak fail unath anith messages wala processing eka nawathinne na.
            // Kenek ge message eka anith kenage nisa waiting nam, ohata
            // "please wait" notice ekak yawanawa (once, queue eke welawe witharai).
            messageQueue.add(
                () => processMessage(sock, msg),
                async (position) => {
                    try {
                        await sock.sendMessage(
                            msg.key.remoteJid,
                            { text: `⏳ මචං, ටිකක් ඉන්න! දැනට කලින් message(s) ටිකක් process වෙමින් තියෙනවා (queue: ${position}). ඉක්මනටම reply කරන්නම්! 🙏` },
                            { quoted: msg }
                        );
                    } catch (e) {
                        console.error('Failed to send queued notice:', e);
                    }
                }
            ).catch((err) => {
                console.error('Queued message processing failed:', err);
            });
        }
    });
}

connectToWhatsApp();
