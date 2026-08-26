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

try {
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    ffmpeg.setFfmpegPath(ffmpegPath);
} catch (e) {
    console.log("Using system installed ffmpeg");
}

// 👑 ADMIN / BATCH REP IDENTIFICATION
const ADMIN_PHONE_NUMBER = "94762513957";
const ADMIN_LID = "17848192627279";

// 📢 GROUP IDs (ANNOUNCEMENT & GENERAL)
const ANNOUNCEMENT_GROUP_ID = "120363425513397101@g.us";
const GENERAL_GROUP_ID = "120363409747625255@g.us";

// 🧵 CONCURRENCY QUEUE
const MAX_CONCURRENT = 3;

class ConcurrencyQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
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

// 🔁 MESSAGE DEDUP
const processedMessages = new Set();
const MAX_TRACKED_MESSAGES = 1000;

function markProcessed(id) {
    processedMessages.add(id);
    if (processedMessages.size > MAX_TRACKED_MESSAGES) {
        const oldest = processedMessages.values().next().value;
        processedMessages.delete(oldest);
    }
}

// 🔒 ADMIN CHECK
function isSenderAdmin(sender) {
    const normalized = jidNormalizedUser(sender) || sender;
    const isPhoneMatch = normalized === `${ADMIN_PHONE_NUMBER}@s.whatsapp.net`;
    const isLidMatch = ADMIN_LID && (normalized === `${ADMIN_LID}@lid` || sender.includes(ADMIN_LID));
    return isPhoneMatch || isLidMatch || sender.includes(ADMIN_PHONE_NUMBER);
}

// Express Web Server Setup
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

// Gemini API Setup
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY environment variable eka set karala nathnam bot ekata Gemini call ganna barinawa.');
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

        // 🛑 සියලුම Group Messages මෙතැනින්ම Ignore කරනු ලැබේ
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

        // Voice Note Processing (Only in DM)
        if (audioMsg) {
            try {
                await sock.sendMessage(sender, { text: "🎙️ **Voice Note එක Process වෙමින් පවතියි...**" }, { quoted: msg });
                const oggBuffer = await downloadMediaMessage(msg, 'buffer', {});
                const mp3Buffer = await convertAudioToWav(oggBuffer);
                const base64Audio = mp3Buffer.toString('base64');
                const audioPart = { inlineData: { data: base64Audio, mimeType: 'audio/mp3' } };
                const prompt = "Listen carefully to this audio message. Reply clearly in friendly Singlish or Sinhala/English.";
                const result = await model.generateContent([prompt, audioPart]);
                const reply = result.response.text();
                await sock.sendMessage(sender, { text: reply }, { quoted: msg });
            } catch (err) {
                console.error('Error processing Audio:', err);
                await sock.sendMessage(sender, { text: "❌ Voice Message එක තේරුම් ගන්න බැරි වුණා." }, { quoted: msg });
            }
            return;
        }

        // PDF Processing (Only in DM)
        if (docMsg) {
            try {
                const mimeType = docMsg?.mimetype || '';
                if (mimeType === 'application/pdf') {
                    await sock.sendMessage(sender, { text: "📄 **PDF Document එක Read කරමින් පවතියි...** පොඩ්ඩක් ඉන්න!" }, { quoted: msg });
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const base64Pdf = buffer.toString('base64');
                    const pdfPart = { inlineData: { data: base64Pdf, mimeType: 'application/pdf' } };
                    const captionPrompt = rawMessageText ? ` User instructions: "${rawMessageText}"` : "";
                    const prompt = "Read this PDF document carefully and fulfill the user request in clear Singlish or simple English." + captionPrompt;
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

        // Image Processing (Only in DM)
        if (imgMsg) {
            try {
                await sock.sendMessage(sender, { text: "⏳ **Image එක Processing...**" }, { quoted: msg });
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const base64Image = buffer.toString('base64');
                const mimeType = imgMsg.mimetype || 'image/jpeg';
                const imagePart = { inlineData: { data: base64Image, mimeType: mimeType } };
                const captionPrompt = rawMessageText ? ` User instructions: "${rawMessageText}"` : "";
                const prompt = "Read all details in this screenshot/image. If requested, generate a clean and formatted announcement notice or answer the user's question clearly in simple English or Singlish." + captionPrompt;
                const result = await model.generateContent([prompt, imagePart]);
                const reply = result.response.text();
                await sock.sendMessage(sender, { text: reply }, { quoted: msg });
            } catch (err) {
                console.error('Error processing Image:', err);
                await sock.sendMessage(sender, { text: "❌ Image එක කියවගන්න බැරි වුණා. කරුණාකර නැවත එවා බලන්න." }, { quoted: msg });
            }
            return;
        }

        // Admin Broadcast Feature (Only via DM)
        const textLower = rawMessageText.toLowerCase().trim();
        const postKeywords = [
            "send this message to group", "send to group", "post to group",
            "yawanna group එකට", "යවන්න group", "group එකට දාන්න", "group එකට දාපන්", "group එකට යවන්න"
        ];
        const isPostRequest = postKeywords.some(keyword => textLower.includes(keyword));

        if (isPostRequest) {
            const isAdmin = isSenderAdmin(sender);

            if (!isAdmin) {
                await sock.sendMessage(sender, { text: "❌ මචං, Group එකට Announcements දාන්න පුළුවන් Batch Rep (Monal) ට විතරයි!" }, { quoted: msg });
                return;
            }
            try {
                let textToPost = quotedText || rawMessageText;

                if (!textToPost || (textToPost === rawMessageText && isPostRequest && !quotedText)) {
                    await sock.sendMessage(sender, { text: "⚠️ මචං, Group එකට දාන්න ඕන Message එකට Reply (Quote) කරලා 'Send to group' කියලා එවන්න!" }, { quoted: msg });
                    return;
                }

                let targetGroupId = ANNOUNCEMENT_GROUP_ID;
                let groupName = "Announcement Group";

                if (textLower.includes("general") || textLower.includes("chat")) {
                    targetGroupId = GENERAL_GROUP_ID;
                    groupName = "General Group";
                }

                const finalMsg = `📢 *ANNOUNCEMENT*\n\n${textToPost}`;

                await sock.sendMessage(targetGroupId, { text: finalMsg });
                await sock.sendMessage(sender, { text: `✅ හරි මචං, මම ඒ Notice එක කෙලින්ම *${groupName}* එකට දැම්මා! 🚀` }, { quoted: msg });
                return;
            } catch (err) {
                console.error('Error broadcasting admin message:', err);
                await sock.sendMessage(sender, { text: "❌ Group එකට Post කිරීමේදී Error එකක් ආවා." }, { quoted: msg });
                return;
            }
        }

        // Standard Text AI Reply (Only in DM)
        if (rawMessageText) {
            try {
                const result = await model.generateContent(fullUserPrompt);
                const replyText = result.response.text();
                await sock.sendMessage(sender, { text: replyText }, { quoted: msg });
            } catch (error) {
                console.error('Error generating AI response:', error);
            }
        }
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            if (processedMessages.has(msg.key.id)) continue;
            markProcessed(msg.key.id);

            messageQueue.add(() => processMessage(sock, msg)).catch((err) => {
                console.error('Queued message processing failed:', err);
            });
        }
    });
}

connectToWhatsApp();
