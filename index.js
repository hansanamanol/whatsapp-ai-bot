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

ffmpeg.setFfmpegPath(ffmpegPath);

// 👑 ADMIN / BATCH REP IDENTIFICATION
const ADMIN_PHONE_NUMBER = "94762513957";
const ADMIN_LID = "17848192627279";
const ADMIN_JIDS = ["178481912627279@lid"];

// ======================================================================
// 📚 CUSTOM KNOWLEDGE BASE (persistent, file-backed)
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

function buildPromptWithKnowledge(basePrompt) {
    if (knowledgeBase.length === 0) return basePrompt;
    const knowledgeText = knowledgeBase.map((k, i) => `${i + 1}. ${k}`).join('\n');
    return `${basePrompt}\n\n[BATCH-SPECIFIC KNOWLEDGE — Batch Rep (Monal) saved this info. If it's relevant to the user's question, prioritize using it over general knowledge:]\n${knowledgeText}`;
}

// ======================================================================
// 📋 STUDENT REGISTRATION SYSTEM (100% reliable phone numbers)
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
    if (normalizedPhone.startsWith('94')) {
        normalizedPhone = normalizedPhone.substring(2);
    } else if (normalizedPhone.startsWith('0')) {
        normalizedPhone = normalizedPhone.substring(1);
    }
    
    const existingJid = Object.keys(studentsDB).find(
        key => studentsDB[key].phone === normalizedPhone && key !== jid
    );
    if (existingJid) {
        return { 
            success: false, 
            error: `This phone number is already registered by ${studentsDB[existingJid].name}. Please use a different number.` 
        };
    }
    
    studentsDB[jid] = {
        name: name.trim(),
        phone: normalizedPhone,
        registeredAt: new Date().toISOString()
    };
    saveStudentsDB();
    
    return { 
        success: true, 
        data: studentsDB[jid] 
    };
}

function getStudentPhone(jid) {
    const normalized = jidNormalizedUser(jid) || jid;
    
    if (studentsDB[jid]) return studentsDB[jid].phone;
    if (studentsDB[normalized]) return studentsDB[normalized].phone;
    
    for (const [key, data] of Object.entries(studentsDB)) {
        if (key.includes(jid) || jid.includes(key)) {
            return data.phone;
        }
    }
    return null;
}

function getStudentInfo(jid) {
    const normalized = jidNormalizedUser(jid) || jid;
    
    if (studentsDB[jid]) return studentsDB[jid];
    if (studentsDB[normalized]) return studentsDB[normalized];
    
    for (const [key, data] of Object.entries(studentsDB)) {
        if (key.includes(jid) || jid.includes(key)) {
            return data;
        }
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
// 🔄 SWAP SYSTEM WITH CONFIRMATION & UNDO
// ======================================================================
const SWAP_REQUESTS_FILE = path.join(__dirname, 'swap-requests.json');
const SWAP_CONFIRMATIONS_FILE = path.join(__dirname, 'swap-confirmations.json');
const SWAP_UNDO_FILE = path.join(__dirname, 'swap-undo.json');

let swapRequests = {};
let pendingConfirmations = {};
let undoData = {};

try {
    if (fs.existsSync(SWAP_REQUESTS_FILE)) {
        swapRequests = JSON.parse(fs.readFileSync(SWAP_REQUESTS_FILE, 'utf8'));
    }
} catch (err) {
    console.error('Error loading swap-requests.json:', err);
    swapRequests = {};
}

try {
    if (fs.existsSync(SWAP_CONFIRMATIONS_FILE)) {
        pendingConfirmations = JSON.parse(fs.readFileSync(SWAP_CONFIRMATIONS_FILE, 'utf8'));
    }
} catch (err) {
    console.error('Error loading swap-confirmations.json:', err);
    pendingConfirmations = {};
}

try {
    if (fs.existsSync(SWAP_UNDO_FILE)) {
        undoData = JSON.parse(fs.readFileSync(SWAP_UNDO_FILE, 'utf8'));
    }
} catch (err) {
    console.error('Error loading swap-undo.json:', err);
    undoData = {};
}

function saveSwapRequests() {
    try {
        fs.writeFileSync(SWAP_REQUESTS_FILE, JSON.stringify(swapRequests, null, 2));
    } catch (err) {
        console.error('Error saving swap-requests.json:', err);
    }
}

function savePendingConfirmations() {
    try {
        fs.writeFileSync(SWAP_CONFIRMATIONS_FILE, JSON.stringify(pendingConfirmations, null, 2));
    } catch (err) {
        console.error('Error saving swap-confirmations.json:', err);
    }
}

function saveUndoData() {
    try {
        fs.writeFileSync(SWAP_UNDO_FILE, JSON.stringify(undoData, null, 2));
    } catch (err) {
        console.error('Error saving swap-undo.json:', err);
    }
}

function normalizeGroupLabel(raw) {
    return raw.toLowerCase().replace(/group|grp|lab/gi, '').trim();
}

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

CRITICAL CODE & TUTORIAL ANALYSIS RULES:
- When analyzing code snippets or tutorials:
  1. Pay EXTREME attention to variable scope and re-initialization (e.g., whether 'j = 1' is initialized OUTSIDE or INSIDE an outer loop).
  2. Distinguish clearly between Sequential/Consecutive loops and Nested loops. Do not multiply iterations unless one loop is strictly nested inside another.
  3. Keep track of accurate question labeling (a, b, c, d, e) without swapping their code contents.
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

// ======================================================================
// 💬 MAIN MESSAGE PROCESSING
// ======================================================================
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

    // ======================================================================
    // 📩 PROCESS MESSAGE FUNCTION
    // ======================================================================
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
        // 🎵 AUDIO MESSAGE HANDLING
        // ======================================================================
        if (audioMsg) {
            try {
                await sock.sendMessage(sender, { text: "🎙️ **Voice Note එක Process වෙමින් පවතියි...**" }, { quoted: msg });
                const oggBuffer = await downloadMediaMessage(msg, 'buffer', {});
                const mp3Buffer = await convertAudioToWav(oggBuffer);
                const base64Audio = mp3Buffer.toString('base64');
                const audioPart = { inlineData: { data: base64Audio, mimeType: 'audio/mp3' } };
                const prompt = buildPromptWithKnowledge("Listen carefully to this audio message. Reply clearly in friendly Singlish or Sinhala/English.");
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
        // 📄 PDF DOCUMENT HANDLING
        // ======================================================================
        if (docMsg) {
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
                    const reply = result.response.text();
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                }
            } catch (err) {
                console.error('Error processing PDF Document:', err);
                await sock.sendMessage(sender, { text: "❌ PDF එක Read කරගන්න බැරි වුණා." }, { quoted: msg });
            }
            return;
        }

        // ======================================================================
        // 🖼️ IMAGE HANDLING
        // ======================================================================
        if (imgMsg) {
            try {
                await sock.sendMessage(sender, { text: "⏳ **Image එක Processing...**" }, { quoted: msg });
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const base64Image = buffer.toString('base64');
                const mimeType = imgMsg.mimetype || 'image/jpeg';
                const imagePart = { inlineData: { data: base64Image, mimeType: mimeType } };
                const captionPrompt = rawMessageText ? ` User instructions: "${rawMessageText}"` : "";
                const prompt = buildPromptWithKnowledge("Read all details in this screenshot/image. If requested, generate a clean and formatted announcement notice or answer the user's question clearly in simple English or Singlish." + captionPrompt);
                const result = await model.generateContent([prompt, imagePart]);
                const reply = result.response.text();
                await sock.sendMessage(sender, { text: reply }, { quoted: msg });
            } catch (err) {
                console.error('Error processing Image:', err);
                await sock.sendMessage(sender, { text: "❌ Image එක කියවගන්න බැරි වුණා. කරුණාකර නැවත එවා බලන්න." }, { quoted: msg });
            }
            return;
        }

        // ======================================================================
        // 💬 TEXT MESSAGE HANDLING
        // ======================================================================
        if (!isGroup) {
            const textLower = rawMessageText.toLowerCase().trim();

            // ==================================================================
            // 👋 IDENTITY CHECK
            // ==================================================================
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
            
            // ==================================================================
            // 🆔 WHOAMI
            // ==================================================================
            if (textLower === 'whoami' || textLower === 'my id' || textLower === 'myid') {
                const normalized = jidNormalizedUser(sender) || sender;
                await sock.sendMessage(
                    sender,
                    { text: `🆔 *ඔයාගේ WhatsApp ID*\n\nRaw: \`${sender}\`\nNormalized: \`${normalized}\`\n\nMe eka ADMIN_JIDS array ekata danna admin access denna.` },
                    { quoted: msg }
                );
                return;
            }

            // ==================================================================
            // 📝 REGISTER COMMAND
            // ==================================================================
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
                        await sock.sendMessage(sender, {
                            text: `⚠️ *Format එක හරියට දෙන්න:*\n\n` +
                                  `\`register: Your Name, 0771234567\`\n` +
                                  `\`register Your Name 0771234567\`\n\n` +
                                  `📱 Example: \`register Kasun Perera, 0762513957\``
                        }, { quoted: msg });
                        return;
                    }
                }
                
                const result = registerStudent(sender, name, phone);
                
                if (result.success) {
                    const displayPhone = formatPhoneForDisplay(result.data.phone);
                    await sock.sendMessage(sender, {
                        text: `✅ *Registration Successful!*\n\n` +
                              `👤 Name: ${result.data.name}\n` +
                              `📱 Phone: ${displayPhone}\n\n` +
                              `🔄 දැන් ඔබගේ real phone number එක swap matches වලට use වෙයි!`
                    }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, {
                        text: `❌ ${result.error}`
                    }, { quoted: msg });
                }
                return;
            }

            // ==================================================================
            // 👤 MY PROFILE
            // ==================================================================
            if (textLower === 'my profile' || textLower === 'profile') {
                const info = getStudentInfo(sender);
                if (info) {
                    const displayPhone = formatPhoneForDisplay(info.phone);
                    await sock.sendMessage(sender, {
                        text: `👤 *Your Profile*\n\n` +
                              `Name: ${info.name}\n` +
                              `Phone: ${displayPhone}\n` +
                              `Registered: ${new Date(info.registeredAt).toLocaleString()}\n\n` +
                              `📝 To update: \`register: New Name, 0771234567\``
                    }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, {
                        text: `⚠️ ඔබ තවම register වෙලා නෑ.\n\n` +
                              `Register වෙන්න: \`register: Your Name, 0771234567\``
                    }, { quoted: msg });
                }
                return;
            }

            // ==================================================================
            // 📋 LIST STUDENTS (admin only)
            // ==================================================================
            if (textLower === 'list students' || textLower === 'students') {
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { 
                        text: "❌ මේක බලන්න පුළුවන් Batch Rep ට විතරයි!" 
                    }, { quoted: msg });
                    return;
                }
                
                const entries = Object.entries(studentsDB);
                if (entries.length === 0) {
                    await sock.sendMessage(sender, { 
                        text: "📭 තවම student කෙනෙක් register වෙලා නෑ." 
                    }, { quoted: msg });
                } else {
                    const list = entries.map(([jid, data], i) => 
                        `${i + 1}. ${data.name} - ${formatPhoneForDisplay(data.phone)}`
                    ).join('\n');
                    await sock.sendMessage(sender, {
                        text: `📋 *Registered Students (${entries.length})*\n\n${list}`
                    }, { quoted: msg });
                }
                return;
            }

            // ==================================================================
            // 👑 ADMIN REGISTER (admin only)
            // ==================================================================
            if (/^admin register\s*:?\s*/.test(textLower)) {
                const isAdmin = isSenderAdmin(sender);
                if (!isAdmin) {
                    await sock.sendMessage(sender, { 
                        text: "❌ මේක කරන්න පුළුවන් Batch Rep ට විතරයි!" 
                    }, { quoted: msg });
                    return;
                }
                
                const parts = rawMessageText.replace(/^admin register\s*:?\s*/i, '').trim();
                const match = parts.match(/^(.+?)\s*,\s*(.+?)\s*,\s*(\d+)$/);
                
                if (!match) {
                    await sock.sendMessage(sender, {
                        text: `⚠️ Format: \`admin register: JID, Name, 0771234567\``
                    }, { quoted: msg });
                    return;
                }
                
                const targetJid = match[1].trim();
                const name = match[2].trim();
                const phone = match[3].trim();
                
                const result = registerStudent(targetJid, name, phone);
                if (result.success) {
                    await sock.sendMessage(sender, {
                        text: `✅ Admin registration successful for ${name}`
                    }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, {
                        text: `❌ ${result.error}`
                    }, { quoted: msg });
                }
                return;
            }

            // ==================================================================
            // 🔄 SWAP REQUEST
            // ==================================================================
            const swapMatch = rawMessageText.match(/^swap\s*:?\s*(.+?)\s+(?:to|->|dakwa)\s+(.+)$/i);
            if (swapMatch) {
                const rawFrom = swapMatch[1].trim();
                const rawTo = swapMatch[2].trim();
                const normFrom = normalizeGroupLabel(rawFrom);
                const normTo = normalizeGroupLabel(rawTo);

                // Check registration
                const studentInfo = getStudentInfo(sender);
                if (!studentInfo) {
                    await sock.sendMessage(sender, {
                        text: `⚠️ *ඔයා තවම register වෙලා නෑ!*\n\n` +
                              `🙏 කරුණාකරලා මුලින්ම register වෙන්න:\n` +
                              `\`register: Your Full Name, 0771234567\`\n\n` +
                              `📝 Example: \`register: Kasun Perera, 0762513957\`\n\n` +
                              `ඊට පස්සේ නැවත swap request එක කරන්න.`
                    }, { quoted: msg });
                    return;
                }

                if (!normFrom || !normTo) {
                    await sock.sendMessage(sender, {
                        text: `⚠️ Format එක: "swap: 1 to 2" වගේ දෙන්න (current group → ඕන group).`
                    }, { quoted: msg });
                    return;
                }

                // Check if user already has a pending request
                if (swapRequests[sender] && !swapRequests[sender].matched) {
                    await sock.sendMessage(sender, {
                        text: `⚠️ ඔබට දැනටමත් pending swap request එකක් තියෙනවා: ${swapRequests[sender].rawFrom} → ${swapRequests[sender].rawTo}\n\n` +
                              `Cancel කරන්න: \`cancel swap\``
                    }, { quoted: msg });
                    return;
                }

                // Save the request
                swapRequests[sender] = {
                    fromGroup: normFrom,
                    toGroup: normTo,
                    rawFrom: rawFrom,
                    rawTo:
