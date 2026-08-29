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
// 📋 STUDENT REGISTRATION SYSTEM
// ======================================================================
const STUDENTS_FILE = path.join(__dirname, 'students.json');
let studentsDB = {};

try {
    if (fs.existsSync(STUDENTS_FILE)) {
        studentsDB = JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8'));
        console.log(`✅ Loaded ${Object.keys(studentsDB).length} registered students`);
    }
} catch (err) {
    console.error('Error loading students.json:', err);
    studentsDB = {};
}

function saveStudentsDB() {
    try {
        fs.writeFileSync(STUDENTS_FILE, JSON.stringify(studentsDB, null, 2));
    } catch (err) {
        console.error('Error saving students.json:', err);
    }
}

function registerStudent(jid, name, phone) {
    const cleanPhone = phone.replace(/[\s\+\-\(\)]/g, '');
    if (!cleanPhone.match(/^(\+?94|0)?7[0-9]{8}$/)) {
        return { success: false, error: 'Invalid Sri Lankan phone number. Use format: 0771234567 or +94771234567' };
    }
    let normalizedPhone = cleanPhone;
    if (normalizedPhone.startsWith('94')) normalizedPhone = normalizedPhone.substring(2);
    else if (normalizedPhone.startsWith('0')) normalizedPhone = normalizedPhone.substring(1);
    
    const existingJid = Object.keys(studentsDB).find(key => studentsDB[key].phone === normalizedPhone && key !== jid);
    if (existingJid) {
        return { success: false, error: `This phone number is already registered by ${studentsDB[existingJid].name}.` };
    }
    studentsDB[jid] = {
        name: name.trim(),
        phone: normalizedPhone,
        registeredAt: new Date().toISOString()
    };
    saveStudentsDB();
    return { success: true, data: studentsDB[jid] };
}

function getStudentInfo(jid) {
    const normalized = jidNormalizedUser(jid) || jid;
    if (studentsDB[jid]) return studentsDB[jid];
    if (studentsDB[normalized]) return studentsDB[normalized];
    for (const [key, data] of Object.entries(studentsDB)) {
        if (key.includes(jid) || jid.includes(key)) return data;
    }
    return null;
}

function formatPhoneForDisplay(phone) {
    if (!phone) return 'Unknown';
    const clean = phone.replace(/[^0-9]/g, '');
    if (clean.length === 9) {
        return `+94 ${clean.substring(0, 3)} ${clean.substring(3, 6)} ${clean.substring(6)}`;
    }
    return `+${clean}`;
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
// 📅 GOOGLE CALENDAR API SETUP
// ======================================================================
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

// ======================================================================
// 📅 CALENDAR FUNCTIONS
// ======================================================================

// Get today's events
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
        console.error('Error fetching today\'s events:', error.message);
        return [];
    }
}

// Get next upcoming event
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

// Get events for a specific date
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

// Format time
function formatEventTime(dateTimeStr) {
    if (!dateTimeStr) return 'All day';
    const date = new Date(dateTimeStr);
    return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
}

function formatDateDisplay(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric'
    });
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
// 🚀 EXPRESS WEB SERVER
// ======================================================================
const app = express();
const PORT = process.env.PORT || 3000;
let latestQR = "";

app.get('/', async (req, res) => {
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
                <head><title>WhatsApp Bot QR Code</title></head>
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
- When students ask for Batch Rep's contact details, phone number, email, or how to contact Monal, provide the following details cleanly:
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
`;

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
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
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
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Logged out. Restarting...');
                process.exit(1);
            }
        } else if (connection === 'open') {
            latestQR = "";
            console.log('✅ WhatsApp AI Bot is Ready and Online!');
        }
    });

    async function processMessage(sock, msg) {
        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
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

        // ======================================================================
        // AUDIO
        // ======================================================================
        if (audioMsg) {
            try {
                await sock.sendMessage(sender, { text: "🎙️ **Voice Note Process වෙමින්...**" }, { quoted: msg });
                const oggBuffer = await downloadMediaMessage(msg, 'buffer', {});
                const mp3Buffer = await convertAudioToWav(oggBuffer);
                const base64Audio = mp3Buffer.toString('base64');
                const audioPart = { inlineData: { data: base64Audio, mimeType: 'audio/mp3' } };
                const prompt = buildPromptWithKnowledge("Listen carefully to this audio message. Reply clearly.");
                const result = await model.generateContent([prompt, audioPart]);
                const reply = result.response.text();
                await sock.sendMessage(sender, { text: reply }, { quoted: msg });
            } catch (err) {
                console.error('Error processing Audio:', err);
                await sock.sendMessage(sender, { text: "❌ Voice Message එක තේරුම් ගන්න බැරි වුණා." }, { quoted: msg });
            }
            return;
        }

        // ======================================================================
        // PDF
        // ======================================================================
        if (docMsg) {
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
                    const reply = result.response.text();
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
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
            try {
                await sock.sendMessage(sender, { text: "⏳ **Image එක Processing...**" }, { quoted: msg });
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const base64Image = buffer.toString('base64');
                const mimeType = imgMsg.mimetype || 'image/jpeg';
                const imagePart = { inlineData: { data: base64Image, mimeType: mimeType } };
                const captionPrompt = rawMessageText ? ` User instructions: "${rawMessageText}"` : "";
                const prompt = buildPromptWithKnowledge("Read all details in this screenshot/image. Answer clearly." + captionPrompt);
                const result = await model.generateContent([prompt, imagePart]);
                const reply = result.response.text();
                await sock.sendMessage(sender, { text: reply }, { quoted: msg });
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
            const textLower = rawMessageText.toLowerCase().trim();

            // ---------- WHO AM I ----------
            const isWhoAmIQuestion = /\bwho\s*am\s*i\b/i.test(textLower)
                || textLower.includes('man kauda') || textLower.includes('mn kauda') || textLower.includes('mama kauda')
                || rawMessageText.includes('මං කවුද') || rawMessageText.includes('මම කවුද');

            if (isWhoAmIQuestion) {
                const isAdmin = isSenderAdmin(sender);
                if (isAdmin) {
                    await sock.sendMessage(sender, { text: `👋 ඔයා තමයි *Monal Hansana* — SLIIT IT Y1S2 Batch Representative! ✅` }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, { text: `👤 ඔයා student කෙනෙක්. Register වෙන්න: \`register: Your Name, 0771234567\`` }, { quoted: msg });
                }
                return;
            }

            // ---------- WHOAMI ----------
            if (textLower === 'whoami' || textLower === 'my id' || textLower === 'myid') {
                const normalized = jidNormalizedUser(sender) || sender;
                await sock.sendMessage(sender, { text: `🆔 *ඔයාගේ WhatsApp ID*\nRaw: \`${sender}\`\nNormalized: \`${normalized}\`` }, { quoted: msg });
                return;
            }

            // ---------- REGISTER ----------
            if (/^register\s*:?\s*/.test(textLower)) {
                const parts = rawMessageText.replace(/^register\s*:?\s*/i, '').trim();
                let name, phone;
                const commaMatch = parts.match(/^(.+?)\s*[,|]\s*(\d+)$/);
                if (commaMatch) {
                    name = commaMatch[1].trim();
                    phone = commaMatch[2].trim();
                } else {
                    const words = parts.split(/\s+/);
                    const lastWord = words[words.length - 1];
                    if (lastWord.match(/^[\+\d]{10,15}$/)) {
                        name = words.slice(0, -1).join(' ');
                        phone = lastWord;
                    } else {
                        await sock.sendMessage(sender, { text: `⚠️ *Format:*\n\`register: Your Name, 0771234567\`` }, { quoted: msg });
                        return;
                    }
                }
                const result = registerStudent(sender, name, phone);
                if (result.success) {
                    await sock.sendMessage(sender, {
                        text: `✅ *Registered!*\n👤 ${result.data.name}\n📱 ${formatPhoneForDisplay(result.data.phone)}`
                    }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, { text: `❌ ${result.error}` }, { quoted: msg });
                }
                return;
            }

            // ---------- MY PROFILE ----------
            if (textLower === 'my profile' || textLower === 'profile') {
                const info = getStudentInfo(sender);
                if (info) {
                    await sock.sendMessage(sender, {
                        text: `👤 *Your Profile*\nName: ${info.name}\nPhone: ${formatPhoneForDisplay(info.phone)}\nRegistered: ${new Date(info.registeredAt).toLocaleString()}`
                    }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, { text: `⚠️ ඔබ තවම register වෙලා නෑ.\nRegister: \`register: Your Name, 0771234567\`` }, { quoted: msg });
                }
                return;
            }

            // ==================================================================
            // 📅 TODAY'S CLASSES (NEW - API)
            // ==================================================================
            if (textLower === 'today classes' || textLower === 'today timetable' || textLower === 'today schedule' || textLower === 'today') {
                const events = await getTodaysEvents();
                if (events.length === 0) {
                    await sock.sendMessage(sender, { 
                        text: `📅 *Today's Schedule*\n\n🎉 No classes scheduled for today! Enjoy your day!` 
                    }, { quoted: msg });
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
                return;
            }

            // ==================================================================
            // 📅 NEXT CLASS (NEW - API)
            // ==================================================================
            if (textLower === 'next class' || textLower === 'next lecture' || textLower === 'next') {
                const event = await getNextEvent();
                if (!event) {
                    await sock.sendMessage(sender, { 
                        text: `📅 *Next Class*\n\n🎉 No upcoming classes found.` 
                    }, { quoted: msg });
                } else {
                    const startTime = event.start.dateTime ? formatEventTime(event.start.dateTime) : 'All day';
                    const date = event.start.dateTime ? formatDateDisplay(event.start.dateTime) : 'Unknown';
                    const location = event.location ? `📍 ${event.location}` : '';
                    
                    let message = `📅 *Next Class*\n\n`;
                    message += `📚 *${event.summary}*\n`;
                    message += `📅 ${date}\n`;
                    message += `🕐 ${startTime}\n`;
                    if (location) message += `${location}\n`;
                    
                    await sock.sendMessage(sender, { text: message }, { quoted: msg });
                }
                return;
            }

            // ==================================================================
            // 📅 CHECK DATE (NEW - API)
            // ==================================================================
            const dateMatch = rawMessageText.match(/^check date\s+(\d{4}-\d{2}-\d{2})$/i);
            if (dateMatch) {
                const dateStr = dateMatch[1];
                const events = await getEventsForDate(dateStr);
                if (events === null) {
                    await sock.sendMessage(sender, { 
                        text: `⚠️ Invalid date format. Use: \`check date YYYY-MM-DD\`\nExample: \`check date 2026-09-01\`` 
                    }, { quoted: msg });
                } else if (events.length === 0) {
                    await sock.sendMessage(sender, { 
                        text: `📅 *Schedule for ${formatDateDisplay(dateStr)}*\n\n🎉 No classes on this day!` 
                    }, { quoted: msg });
                } else {
                    let message = `📅 *Schedule for ${formatDateDisplay(dateStr)}*\n\n`;
                    events.forEach((event, i) => {
                        const time = event.start.dateTime ? formatEventTime(event.start.dateTime) : 'All day';
                        message += `${i+1}. *${event.summary}*\n   🕐 ${time}\n\n`;
                    });
                    await sock.sendMessage(sender, { text: message }, { quoted: msg });
                }
                return;
            }

            // ---------- 📅 CALENDAR / TIMETABLE (ICS Link) ----------
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

⚠️ *පෙන්නන්නේ නැත්නම්:* ඉහත *"Other calendars"* එක Check කරලා Auto-Sync ON කරන්න.`
                }, { quoted: msg });
                return;
            }

            // ---------- CALENDAR HELP ----------
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

            // ---------- LIST STUDENTS (Admin) ----------
            if (textLower === 'list students' || textLower === 'students') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                const entries = Object.entries(studentsDB);
                if (entries.length === 0) {
                    await sock.sendMessage(sender, { text: "📭 Students නෑ." }, { quoted: msg });
                } else {
                    const list = entries.map(([jid, data], i) => `${i+1}. ${data.name} - ${formatPhoneForDisplay(data.phone)}`).join('\n');
                    await sock.sendMessage(sender, { text: `📋 *Registered Students (${entries.length})*\n${list}` }, { quoted: msg });
                }
                return;
            }

            // ---------- ADMIN REGISTER ----------
            if (/^admin register\s*:?\s*/.test(textLower)) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                const parts = rawMessageText.replace(/^admin register\s*:?\s*/i, '').trim();
                const match = parts.match(/^(.+?)\s*,\s*(.+?)\s*,\s*(\d+)$/);
                if (!match) {
                    await sock.sendMessage(sender, { text: `⚠️ Format: \`admin register: JID, Name, 0771234567\`` }, { quoted: msg });
                    return;
                }
                const targetJid = match[1].trim();
                const name = match[2].trim();
                const phone = match[3].trim();
                const result = registerStudent(targetJid, name, phone);
                await sock.sendMessage(sender, { text: result.success ? `✅ Registered ${name}` : `❌ ${result.error}` }, { quoted: msg });
                return;
            }

            // ---------- ADD INFO (Admin) ----------
            if (/^(add info|info add|save info)\b/i.test(textLower)) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ මචං, Info Add කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                const infoText = rawMessageText.replace(/^(add info|info add|save info)\s*:?\s*/i, '').trim();
                if (!infoText) {
                    await sock.sendMessage(sender, { text: `⚠️ මචං, info text එකත් එක්කම type කරන්න.` }, { quoted: msg });
                    return;
                }
                knowledgeBase.push(infoText);
                saveKnowledgeBase();
                await sock.sendMessage(sender, { text: `✅ Info එක save කළා! (Total: ${knowledgeBase.length})` }, { quoted: msg });
                return;
            }

            // ---------- LIST INFO (Admin) ----------
            if (textLower === 'list info' || textLower === 'show info') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ මචං, මේක බලන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                if (knowledgeBase.length === 0) {
                    await sock.sendMessage(sender, { text: "📭 දැනට info මොකවත් save කරලා නෑ." }, { quoted: msg });
                } else {
                    const list = knowledgeBase.map((k, i) => `${i+1}. ${k}`).join('\n\n');
                    await sock.sendMessage(sender, { text: `📚 *Saved Info (${knowledgeBase.length})*\n\n${list}` }, { quoted: msg });
                }
                return;
            }

            // ---------- REMOVE INFO (Admin) ----------
            if (/^remove info\s+\d+/i.test(textLower)) {
                if (!isSenderAdmin(sender)) {
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

            // ---------- AI RESPONSE ----------
            if (rawMessageText) {
                try {
                    const result = await model.generateContent(buildPromptWithKnowledge(fullUserPrompt));
                    const replyText = result.response.text();
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
            if (processedMessages.has(msg.key.id)) continue;
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
}

connectToWhatsApp();
