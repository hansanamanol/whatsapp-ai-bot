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
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

ffmpeg.setFfmpegPath(ffmpegPath);

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
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const systemInstruction = `
You are an intelligent Gemini AI assistant working for the SLIIT IT Batch Representative (Monal). 
You behave like a natural conversational AI.

YOUR RESPONSIBILITIES:
1. Helping Students:
   - Answer student questions naturally in Singlish, Sinhala, or English based on the user's language.
   - Assist them with Timetable info, Calendar link, Issue forms, and LIC contacts.
   - Listen to voice notes (audio) sent by students/admin and reply appropriately in text or help them with their query.
   - Always pay close attention to quoted/replied context if provided.

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
    model: "gemini-3.1-flash-lite",
    systemInstruction: systemInstruction 
});

const ADMIN_NUMBER = "94762513957@s.whatsapp.net";
const BATCH_GROUP_ID = "120363425513397101@g.us"; 

// Helper function to convert WhatsApp Audio (OGG/Opus) to MP3/WAV
function convertAudioToWav(inputBuffer) {
    return new Promise((resolve, reject) => {
        const tempIn = path.join(__dirname, `temp_${Date.now()}.ogg`);
        const tempOut = path.join(__dirname, `temp_${Date.now()}.mp3`);

        fs.writeFileSync(tempIn, inputBuffer);

        ffmpeg(tempIn)
            .toFormat('mp3')
            .on('end', () => {
                const outputBuffer = fs.readFileSync(tempOut);
                fs.unlinkSync(tempIn);
                fs.unlinkSync(tempOut);
                resolve(outputBuffer);
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
        logger: pino({ level: 'silent' })
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

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const sender = msg.key.remoteJid;
            const messageType = Object.keys(msg.message)[0];
            const isGroup = sender.endsWith('@g.us');

            if (isGroup && sender !== BATCH_GROUP_ID) continue; 

            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate('composing', sender);

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

            // 🎙️ AUDIO / VOICE MESSAGE PROCESSING
            if (messageType === 'audioMessage') {
                try {
                    await sock.sendMessage(sender, { 
                        text: "🎙️ **Voice Note එක ඇහෙමින් පවතියි...** පොඩ්ඩක් ඉන්න, මම ඒක අහලා උත්තරයක් දෙන්නම්!" 
                    }, { quoted: msg });

                    const oggBuffer = await downloadMediaMessage(msg, 'buffer', {});
                    const mp3Buffer = await convertAudioToWav(oggBuffer);
                    const base64Audio = mp3Buffer.toString('base64');

                    const audioPart = {
                        inlineData: { data: base64Audio, mimeType: 'audio/mp3' }
                    };

                    const prompt = "Listen carefully to this audio message from the student/admin. Understand what they are saying and reply clearly in friendly Singlish or Sinhala/English based on their language.";
                    const result = await model.generateContent([prompt, audioPart]);
                    const reply = result.response.text();

                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                    return;

                } catch (err) {
                    console.error('Error processing Audio:', err);
                    await sock.sendMessage(sender, { text: "❌ අයියෝ Voice Message එක තේරුම් ගන්න බැරි වුණා. පැහැදිලිව ආයේ එකක් දාන්නකෝ." }, { quoted: msg });
                    return;
                }
            }

            // 📸 IMAGE MESSAGE PROCESSING
            if (messageType === 'imageMessage') {
                try {
                    await sock.sendMessage(sender, { 
                        text: "⏳ **Image එක Processing...** පොඩ්ඩක් ඉන්න, මම මේක බලලා ඉක්මනින්ම විස්තර කරන්නම්!" 
                    }, { quoted: msg });

                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const base64Image = buffer.toString('base64');
                    const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';

                    const imagePart = {
                        inlineData: { data: base64Image, mimeType: mimeType }
                    };

                    const captionPrompt = rawMessageText ? ` User prompt/caption: "${rawMessageText}"` : "";

                    if (sender === ADMIN_NUMBER) {
                        const prompt = "Read this image notice and write a clear, attractive student announcement in SIMPLE ENGLISH. Use bold text for key dates, times, and instructions. Output ONLY the notice text without intro/outro." + captionPrompt;
                        const result = await model.generateContent([prompt, imagePart]);
                        const announcement = result.response.text();

                        const finalMsg = `📢 *ANNOUNCEMENT*\n\n${announcement}`;

                        await sock.sendMessage(BATCH_GROUP_ID, { image: buffer, caption: finalMsg });
                        await sock.sendMessage(sender, { text: "✅ Image එකයි Simple English Notice එකයි Group එකට දැම්මා!" }, { quoted: msg });
                    } else {
                        const prompt = "Read this image notice/document. Explain its details clearly to the student in friendly Singlish or simple English based on what they asked." + captionPrompt;
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
                        const prompt = `The Batch Rep sent this message: "${fullUserPrompt}".
Translate and convert this message into a well-formatted, clean, and SIMPLE ENGLISH announcement notice for university students. 
Use clear structure, bold headings/key details, and appropriate emojis. 
CRITICAL: Output ONLY the final simple English notice text.`;

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
