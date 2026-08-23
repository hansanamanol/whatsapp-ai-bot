const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');

// 🌐 Express Web Server for Railway Health Check & QR Code Display
const app = express();
const PORT = process.env.PORT || 3000;
let latestQR = "";

app.get('/', async (req, res) => {
    if (!latestQR) {
        return res.send("<body style='background:#0d1117;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;'><h2>🚀 HansanaBot is Active & Connected!</h2></body>");
    }
    const qrImage = await QRCode.toDataURL(latestQR);
    res.send(`<body style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;background:#0d1117;color:white;font-family:sans-serif;">
        <h2>Scan QR Code to Connect HansanaBot</h2>
        <img src="${qrImage}" style="width:280px;border:8px solid white;border-radius:10px;"/>
        <p style="margin-top:15px;color:#8b949e;">Scan using your dedicated Bot WhatsApp Account</p>
    </body>`);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// 🤖 Official Gemini AI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const systemInstruction = `
You are HansanaBot, an intelligent and friendly Gemini AI Assistant created for SLIIT IT Students.
You represent and assist the SLIIT IT Batch Representative: Monal Hansana.

YOUR CORE ROLE & RESPONSIBILITIES:
- Answer student questions about SLIIT Y1S2 modules, timetables, LMS links, LIC emails, forms, and general academic guidelines.
- Reply naturally in polite Singlish, English, or Sinhala depending on how the student texts.
- Keep replies short, clean, structured, and easy to read.

BATCH REPRESENTATIVE DETAILS:
- Batch Rep Name: Monal Hansana
- Contact Number: +94 76 251 3957 (076 251 3957)
- Official SLIIT Email: it26100930@my.sliit.lk
- Role: SLIIT IT Batch Representative (Matara / General Cohort)

SLIIT ACADEMIC & LIC INFORMATION (Y1S2):
1. IT1170 - Data Structures and Algorithms (DSA) | LIC: Prof. Nathali Silva (nathali.s@sliit.lk)
2. IT1160 - Discrete Mathematics | LIC: Ms. Nipuni Maleesha (nipuni.m@sliit.lk)
3. SE1020 - Object Oriented Programming (OOP) | LIC: Ms. Thilini Jayalath (thilini.j@sliit.lk)
4. IT1150 - Technical Writing | LIC: Ms. Dinushika Jayathissa (dinushika.j@sliit.lk)
5. IE1011 - Information Systems | LIC: Ms. Chathurangika Kahandawarachchi (chathurangika.k@sliit.lk)

IMPORTANT SLIIT LINKS:
- Timetable / Google Calendar: https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t
- LMS (Courseweb): https://courseweb.sliit.lk/
- Eduscope (Recordings): https://eduscope.sliit.lk/
- Student Issue Reporting Form: https://docs.google.com/forms/d/e/1FAIpQLSfOUJnkMp8Tdig0C187WDOgU5AZmtPh3ayBZ-_z9xd23K3Zgw/viewform?usp=publish-editor
- Helpdesk: https://ask.sliit.lk/

IMPORTANT RULES:
- Minimum 80% attendance is required for labs and lectures to qualify for final exams.
- Do NOT perform any administrative tasks like posting messages to groups. If asked, inform that announcements are handled solely by the Batch Rep.
`;

const model = genAI.getGenerativeModel({ 
    model: "gemini-3.5-flash-lite",
    systemInstruction: systemInstruction 
});

// 🛡️ Rate Limiter (Cooldown of 3 seconds per user)
const userCooldowns = new Map();
const COOLDOWN_TIME_MS = 3000;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        keepAliveIntervalMs: 20000,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) {
            latestQR = qr;
            console.log("👉 New QR Code available on Web URL!");
        }
        if (connection === 'open') {
            latestQR = "";
            console.log('🚀 ✅ HansanaBot is ONLINE & READY!');
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log("🔄 Reconnecting...");
                setTimeout(() => startBot(), 3000);
            } else {
                console.log("❌ Connection Logged Out. Please restart container to re-scan QR.");
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        for (const msg of messages) {
            try {
                // Ignore empty messages, status updates, or messages sent by the bot itself
                if (!msg.message || msg.key.fromMe) continue;

                const remoteJid = msg.key.remoteJid;
                
                // 🛑 Block Group Messages (Only allow DM support)
                if (remoteJid.endsWith('@g.us')) continue;

                // Rate limiting check
                const now = Date.now();
                if (userCooldowns.has(remoteJid)) {
                    if (now - userCooldowns.get(remoteJid) < COOLDOWN_TIME_MS) continue;
                }
                userCooldowns.set(remoteJid, now);

                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || "";

                if (!text) continue;

                console.log(`📩 New DM from ${remoteJid}: "${text}"`);
                await sock.sendPresenceUpdate('composing', remoteJid);

                // Generate Response using Gemini API
                const result = await model.generateContent(text);
                const replyText = result.response.text();

                if (replyText) {
                    await sock.sendMessage(remoteJid, { text: replyText });
                    console.log(`✅ Replied successfully to ${remoteJid}`);
                }

            } catch (err) {
                console.error("❌ Message Error:", err);
            }
        }
    });
}

startBot();
