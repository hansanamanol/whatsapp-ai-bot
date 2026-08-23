sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    for (const msg of messages) {
        try {
            if (!msg.message || msg.key.fromMe) continue;

            const remoteJid = msg.key.remoteJid;
            if (remoteJid.endsWith('@g.us')) continue; // Group ignore

            // 🎯 CRITICAL FIX: Extract Real Phone JID (@s.whatsapp.net) even if incoming is @lid
            let realJid = remoteJid;

            if (remoteJid.endsWith('@lid')) {
                // Sender ගේ actual Phone Number JID එක contextInfo වලින් හෝ participant වෙතින් ලබා ගැනීම
                const senderPn = msg.key.participant || 
                                 msg.message?.extendedTextMessage?.contextInfo?.participant ||
                                 msg.message?.imageMessage?.contextInfo?.participant;

                if (senderPn && senderPn.endsWith('@s.whatsapp.net')) {
                    realJid = senderPn;
                } else if (sock.signalRepository?.jidToNumJid) {
                    // Baileys Signal Repository mapping එක පාවිච්චි කිරීම
                    try {
                        const mapped = await sock.signalRepository.jidToNumJid(remoteJid);
                        if (mapped) realJid = `${mapped}@s.whatsapp.net`;
                    } catch (e) {}
                }
            }

            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || "";

            if (!text) continue;

            console.log(`📩 New DM from ${realJid} (Original: ${remoteJid}): "${text}"`);
            await sock.sendPresenceUpdate('composing', remoteJid);

            // Generate Response
            const result = await model.generateContent(text);
            const replyText = result.response.text();

            if (replyText) {
                // 🚀 Direct Reply: Try sending to realJid first, or quoted to remoteJid
                if (realJid !== remoteJid) {
                    await sock.sendMessage(realJid, { text: replyText });
                } else {
                    await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                }
                console.log(`✅ Sent reply to ${realJid}`);
            }

        } catch (err) {
            console.error("❌ Message Error:", err);
        }
    }
});
