const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage 
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const pino = require('pino');
const gTTS = require('gtts');
const fs = require('fs');
const path = require('path');

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

// Helper Function: Text to Speech (TTS)
function sendVoiceResponse(sock, sender, text, quotedMsg) {
    return new Promise((resolve, reject) => {
        try {
            // Shorten text if too long for clean voice generation
            const cleanText = text.replace(/[*_~`#]/g, '').slice(0, 400);
            const gtts = new gTTS(cleanText, 'en'); 
            const filePath = path.join(__dirname, `reply_${Date.now()}.mp3`);

            gtts.save(filePath, async function (err, result) {
                if (err) {
                    console.error('gTTS Error:', err);
                    return resolve();
                }
                try {
                    const audioBuffer = fs.readFileSync(filePath);
                    await sock.sendMessage(sender, { 
                        audio: audioBuffer, 
                        mimetype: 'audio/mp4', 
                        ptt: true // Sends as a Voice Note (PTT)
                    }, { quoted: quotedMsg });

                    // Clean up temp file
                    fs.unlinkSync(filePath);
                    resolve();
                } catch (sendErr) {
                    console.error('Error sending audio message:', sendErr);
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                    resolve();
                }
            });
        } catch (e) {
            console.error('TTS Exception:', e);
            resolve();
        }
    });
}

// Gemini API Setup
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const systemInstruction = `
You are an intelligent Gemini AI assistant working for the SLIIT IT Batch Representative (Monal). 
You behave like a natural conversational AI (just like the official Gemini app).

YOUR RESPONSIBILITIES:
1. Helping Students:
   - Answer student questions naturally, friendly, and accurately in Singlish, Sinhala, or English based on the user's language.
   - You can listen to Audio/Voice messages sent in Sinhala, English, or Singlish and respond accurately.
   - Keep voice responses concise, clear, and easy to speak out loud.
   - Assist them with Timetable info, Calendar link, Issue forms, and LIC contacts.
   - Read images/notices sent by students and explain or summarize them clearly.

2. Assisting the Batch Rep (Admin):
   - When the Batch Rep asks you to post or announce something, translate and rephrase it into clear, simple, professional English formatted as an official student notice.

Important Links & Info:
1. Timetable / Calendar: https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t
2. Issue Reporting Form: https://docs.google.com/forms/d/e/1FAIpQLSfOUJnkMp8Tdig0C187WDOgU5AZmtPh3ayBZ-_z9xd23K3Zgw/viewform?usp=publish-editor
3. SLIIT Support: https://ask.sliit.lk/
4. Lecturer In Charge (LIC) Details:
   - IT1150 - Technical Writing: Ms. Dinushika Jayathissa (dinushika.j@sliit.lk)
   - IT1160 - Discrete Mathematics: Ms. Nipuni Maleesha (nipuni.m@sliit.lk)
   - IT1170 - Data Structures and Algorithms: Prof. Nathali Silva (nathali.s@sliit.lk)
   - SE1020 - Object Oriented Programming: Ms. Thilini Jayalath (thilini.j@sliit.lk)
   - IE1011 - Information Systems: Ms. Chathurangika Kahandawarachchi (chathurangika.k@sliit.lk)
`;

const model = genAI.getGenerativeModel({ 
    model: "gemini-3.6-flash",
    systemInstruction: systemInstruction 
});

const ADMIN_NUMBER = "94762513957@s.whatsapp.net";
const BATCH_GROUP_ID = "120363425513397101@g.us"; 

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            console.log('\n=================== SCAN QR CODE BELOW ===================\n');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('\n==========================================================\n');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Logged out. Restarting process...');
                process.exit(1);
            }
        } else if (connection === 'open') {
            latestQR = "";
            console.log('✅ WhatsApp AI Bot is Ready and Online!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const sender = msg.key.remoteJid;
            const messageType = Object.keys(msg.message)[0];
            const isGroup = sender.endsWith('@g.us');

            if (isGroup && sender !== BATCH_GROUP_ID) continue; 

            // Blue Tick (Seen) & Typing status
            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate('composing', sender);

            // Extract Quoted Message Context
            const contextInfo = msg.message[messageType]?.contextInfo;
            const quotedText = contextInfo?.quotedMessage?.conversation ||
                              contextInfo?.quotedMessage?.extendedTextMessage?.text ||
                              contextInfo?.quotedMessage?.imageMessage?.caption || "";

            const rawMessageText = msg.message.conversation || 
                                   msg.message.extendedTextMessage?.text || 
                                   msg.message.imageMessage?.caption || "";

            let fullUserPrompt = rawMessageText;
            if (quotedText) {
                fullUserPrompt = `[Context / Previous Message Being Replied To: "${quotedText}"]\nUser Current Response: "${rawMessageText}"`;
            }

            // 🎙️ VOICE / AUDIO MESSAGE PROCESSING
            if (messageType === 'audioMessage') {
                try {
                    await sock.sendMessage(sender, { 
                        text: "🎙️ **Voice message එක අහන ගමන්...**" 
                    }, { quoted: msg });

                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const base64Audio = buffer.toString('base64');
                    const mimeType = msg.message.audioMessage.mimetype || 'audio/ogg';

                    const audioPart = {
                        inlineData: { data: base64Audio, mimeType: mimeType.split(';')[0] }
                    };

                    if (sender === ADMIN_NUMBER) {
                        const prompt = "Listen to this voice message from the Batch Rep. If it is an announcement to post, write a clean SIMPLE ENGLISH notice. Otherwise, reply naturally. Context: " + (quotedText ? `"${quotedText}"` : "None");
                        const result = await model.generateContent([prompt, audioPart]);
                        const responseText = result.response.text();

                        if (responseText.toLowerCase().includes("announcement") || responseText.toLowerCase().includes("notice")) {
                            const finalMsg = `📢 *ANNOUNCEMENT*\n\n${responseText}`;
                            await sock.sendMessage(BATCH_GROUP_ID, { text: finalMsg });
                            await sock.sendMessage(sender, { text: "හරි මචං, ඔයා Voice Note එකෙන් කියපු එක Announcement එකක් කරලා Group එකට දැම්මා! 👍" }, { quoted: msg });
                        } else {
                            await sock.sendMessage(sender, { text: responseText }, { quoted: msg });
                            await sendVoiceResponse(sock, sender, responseText, msg);
                        }
                    } else {
                        const prompt = "Listen to this student voice message. Answer clearly and helpfully. Context: " + (quotedText ? `"${quotedText}"` : "None");
                        const result = await model.generateContent([prompt, audioPart]);
                        const reply = result.response.text();

                        // Send Text Reply AND Voice Note Reply
                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                        await sendVoiceResponse(sock, sender, reply, msg);
                    }
                    return;

                } catch (err) {
                    console.error('Error processing Voice Message:', err);
                    await sock.sendMessage(sender, { text: "❌ අයියෝ Voice Note එක පැහැදිලි නැහැ, ආයේ දාලා බලන්න." }, { quoted: msg });
                    return;
                }
            }

            // 📸 IMAGE MESSAGE PROCESSING
            if (messageType === 'imageMessage') {
                try {
                    await sock.sendMessage(sender, { 
                        text: "⏳ **Image එක Processing...**" 
                    }, { quoted: msg });

                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const base64Image = buffer.toString('base64');
                    const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';

                    const imagePart = {
                        inlineData: { data: base64Image, mimeType: mimeType }
                    };

                    const captionPrompt = rawMessageText ? ` User prompt: "${rawMessageText}"` : "";
                    
                    if (sender === ADMIN_NUMBER) {
                        const prompt = "Read this image notice and write a clear student announcement in SIMPLE ENGLISH." + captionPrompt;
                        const result = await model.generateContent([prompt, imagePart]);
                        const announcement = result.response.text();

                        const finalMsg = `📢 *ANNOUNCEMENT*\n\n${announcement}`;

                        await sock.sendMessage(BATCH_GROUP_ID, { image: buffer, caption: finalMsg });
                        await sock.sendMessage(sender, { text: "✅ Image එකයි Notice එකයි Group එකට දැම්මා!" }, { quoted: msg });
                    } else {
                        const prompt = "Read this image notice/document and explain it clearly to the student." + captionPrompt;
                        const result = await model.generateContent([prompt, imagePart]);
                        const reply = result.response.text();

                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                    }
                    return;

                } catch (err) {
                    console.error('Error processing Image:', err);
                    await sock.sendMessage(sender, { text: "❌ අයියෝ Image එක කියවගන්න බැරි වුණා, ආයේ දාලා බලන්න." }, { quoted: msg });
                    return;
                }
            }

            // 💬 TEXT MESSAGE PROCESSING
            if (sender === ADMIN_NUMBER) {
                const text = rawMessageText.toLowerCase();
                if (text.includes("කියපන්") || text.includes("කියන්න") || text.includes("දාපන්") || text.includes("දාන්න") || text.includes("inform") || text.includes("tell") || text.includes("post") || text.includes("announce")) {
                    try {
                        const prompt = `The Batch Rep sent this message: "${fullUserPrompt}". Translate and convert this message into a simple English announcement notice for students. Output ONLY the notice text.`;

                        const result = await model.generateContent(prompt);
                        const announcement = result.response.text();

                        const finalMsg = `📢 *ANNOUNCEMENT*\n\n${announcement}`;

                        await sock.sendMessage(BATCH_GROUP_ID, { text: finalMsg });
                        await sock.sendMessage(sender, { text: "හරි මචං, මම ඒක Simple English වලින් Translate කරලා Group එකට දැම්මා! 👍" }, { quoted: msg });
                        return;
                    } catch (err) {
                        console.error('Error broadcasting admin message:', err);
                    }
                }
            }

            // Normal AI Text Response for Students & Admin
            if (isGroup) return;

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
    });
}

connectToWhatsApp();
