        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                latestQR = qr;
                isConnected = false;
                qrcodeTerminal.generate(qr, { small: true });
            }
            if (connection === 'close') {
                isConnected = false;
                // ⬇️ මේ lines ටික add කරන්න (ඇත්තම error එක බලන්න)
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                console.error("❌ WhatsApp Connection Closed! Status Code:", statusCode);
                console.error("❌ Full Error:", lastDisconnect?.error);
                // ⬆️ ඉවරයි

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                sock.ev.removeAllListeners();
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting in 3s...');
                    setTimeout(() => connectToWhatsApp().catch(console.error), 3000);
                } else {
                    console.log('Logged out. Exiting.');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                latestQR = "";
                isConnected = true;
                console.log('✅ WhatsApp AI Bot is Ready and Online!');
            }
        });
