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

YOUR RESPONSIBILITIES:
1. Helping Students:
   - Answer student questions naturally in Singlish, Sinhala, or English based on the user's language.
   - Assist them with Timetable info, Calendar link, Issue forms, and LIC contacts.
   - Read images, voice notes, and PDFs provided by users accurately.

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

const BATCH_GROUP_ID = "120363425513397101@g.us"; 

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
            const isGroup = sender.endsWith('@g.us');

            if (isGroup && sender !== BATCH_GROUP_ID) continue; 

            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate('composing', sender);

            // Extract Image Object dynamically (Handles Normal, ViewOnce, and Ephemeral Messages)
            const imgMsg = msg.message.imageMessage || 
                           msg.message.viewOnceMessage?.message?.imageMessage ||
                           msg.message.viewOnceMessageV2?.message?.imageMessage ||
                           msg.message.ephemeralMessage?.message?.imageMessage;

            // Extract Audio Object
            const audioMsg = msg.message.audioMessage ||
                             msg.message.viewOnceMessage?.message?.audioMessage ||
                             msg.message.ephemeralMessage?.message?.audioMessage;

            // Extract Document Object
            const docMsg = msg.message.documentMessage || 
                           msg.message.documentWithCaptionMessage?.message?.documentMessage ||
                           msg.message.ephemeralMessage?.message?.documentMessage;

            const contextInfo = msg.message[Object.keys(msg.message)[0]]?.contextInfo;
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

            // 🎙️ AUDIO / VOICE MESSAGE PROCESSING
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
                    return;
                } catch (err) {
                    console.error('Error processing Audio:', err);
                    await sock.sendMessage(sender, { text: "❌ Voice Message එක තේරුම් ගන්න බැරි වුණා." }, { quoted: msg });
                    return;
                }
            }

            // 📄 DOCUMENT / PDF MESSAGE PROCESSING
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
                        return;
                    }
                } catch (err) {
                    console.error('Error processing PDF Document:', err);
                    await sock.sendMessage(sender, { text: "❌ PDF එක Read කරගන්න බැරි වුණා." }, { quoted: msg });
                    return;
                }
            }

            // 📸 IMAGE MESSAGE PROCESSING
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
                    return;
                } catch (err) {
                    console.error('Error processing Image:', err);
                    await sock.sendMessage(sender, { text: "❌ Image එක කියවගන්න බැරි වුණා. කරුණාකර නැවත එවා බලන්න." }, { quoted: msg });
                    return;
                }
            }

            // 💬 DIRECT MESSAGE BROADCAST COMMAND (DM Only)
            if (!isGroup) {
                const textLower = rawMessageText.toLowerCase();
                const postKeywords = ["this one", "yawanna", "යවන්න", "send this", "post this", "send to group", "post to group", "දාන්න", "දාපන්", "කියන්න", "කියපන්"];
                
                const isPostRequest = postKeywords.some(keyword => textLower.includes(keyword));

                if (isPostRequest) {
                    try {
                        let finalContentToPost = "";

                        if (quotedText) {
                            const prompt = `The user wants to post this quoted content to the student group: "${quotedText}".
Convert and format this content into a clean, professional, simple English student announcement with emojis and bold key details. 
Output ONLY the final announcement text without intro/outro text!`;

                            const result = await model.generateContent(prompt);
                            finalContentToPost = result.response.text();
                        } else {
                            const prompt = `Convert this text into a clean simple English announcement notice for university students: "${rawMessageText}". Output ONLY the final notice text!`;
                            const result = await model.generateContent(prompt);
                            finalContentToPost = result.response.text();
                        }

                        const finalMsg = `📢 *ANNOUNCEMENT*\n\n${finalContentToPost}`;

                        await sock.sendMessage(BATCH_GROUP_ID, { text: finalMsg });
                        await sock.sendMessage(sender, { text: "✅ හරි මචං, මම ඒ Notice එක කෙලින්ම Group එකට දැම්මා! 🚀" }, { quoted: msg });
                        return;
                    } catch (err) {
                        console.error('Error broadcasting admin message:', err);
                        await sock.sendMessage(sender, { text: "❌ Group එකට Post කිරීමේදී Error එකක් ආවා." }, { quoted: msg });
                        return;
                    }
                }
            }

            if (isGroup) return;

            // Normal DM Chat Response
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
