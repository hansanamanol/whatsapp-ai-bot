const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');

// 🌐 Railway Web Server for Keeping App Alive & QR Scanning
const app = express();
const PORT = process.env.PORT || 3000;
let latestQR = "";

app.get('/', async (req, res) => {
    if (!latestQR) return res.send("<body style='background:#0d1117;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;'><h2>🚀 HansanaBot is Active & Ready!</h2></body>");
    const qrImage = await QRCode.toDataURL(latestQR);
    res.send(`<body style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;background:#0d1117;color:white;font-family:sans-serif;">
        <h2>Scan QR Code to Connect HansanaBot</h2>
        <img src="${qrImage}" style="width:280px;border:8px solid white;border-radius:10px;"/>
    </body>`);
});
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// 🤖 Gemini Setup (Using fast and lightweight official Gemini model)
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

// 🛡️ Rate Limiting Mechanism (Spam & Multi-User Traffic Control)
const userCooldowns = new Map();
const COOLDOWN_TIME_MS = 3000; // 3 Seconds delay per user

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        keepAliveIntervalMs: 20000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) {
            latestQR = qr;
            console.log("👉 New QR Code available on Railway URL!");
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
                console.log("❌ Logged out. Resetting...");
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        for (const msg of messages) {
            try {
                // Ignore empty messages, status updates, or own messages
                if (!msg.message || msg.key.fromMe) continue;

                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');

                // 🛑 Groups අතහැර Direct Private Messages (PM) වලට විතරක් Reply කරමු
                if (isGroup) continue;

                // 🛡️ Rate Limiting Check (ලමයි ගොඩක් එකපාර Message එවද්දී Control කරන්න)
                const now = Date.now();
                if (userCooldowns.has(jid)) {
                    const lastMsgTime = userCooldowns.get(jid);
                    if (now - lastMsgTime < COOLDOWN_TIME_MS) {
                        continue; // Skip rapid spam messages from the same user
                    }
                }
                userCooldowns.set(jid, now);

                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || "";
                
                const imgMsg = msg.message.imageMessage;

                if (!text && !imgMsg) continue;

                console.log(`📩 Received Message from ${jid}: "${text}"`);

                await sock.sendPresenceUpdate('composing', jid);

                let replyText = "";

                // 📸 Image එක්ක ප්‍රශ්නයක් ඇහුවොත් (e.g. Schedule/Question Screenshot)
                if (imgMsg) {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const imagePart = { inlineData: { data: buffer.toString('base64'), mimeType: imgMsg.mimetype || 'image/jpeg' } };
                    const prompt = text ? text : "Explain or solve this academic image for the student.";
                    
                    const result = await model.generateContent([prompt, imagePart]);
                    replyText = result.response.text();
                } 
                // 💬 Normal Text Message
                else {
                    const result = await model.generateContent(text);
                    replyText = result.response.text();
                }

                if (replyText) {
                    await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
                    console.log(`✅ Replied to ${jid}`);
                }

            } catch (err) {
                console.error("❌ Error handling message:", err);
            }
        }
    });
}

startBot();
