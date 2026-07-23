/**
 * MATCH Contact Bot - Pairing Code Only (Optimized for Third-Party)
 * Owner links via phone number, no QR needed.
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const http = require('http');
const { findUnsavedNumbers, buildVcf } = require('./contacts');

const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const PHONE_NUMBER = process.env.PHONE_NUMBER?.trim(); // e.g. "2348012345678"

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MATCH Contact Bot is running.\n');
  })
  .listen(PORT, () => console.log(`Healthcheck server listening on port ${PORT}`));

const contactStore = {};

async function startBot(retryCount = 0) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  if (!PHONE_NUMBER) {
    console.error('\n❌ Set the PHONE_NUMBER environment variable and restart.\n');
    process.exit(1);
  }

  sock.ev.on('creds.update', saveCreds);

  // Contact store
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) contactStore[c.id] = c;
  });
  sock.ev.on('contacts.set', ({ contacts }) => {
    for (const c of contacts) contactStore[c.id] = c;
  });
  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) {
      contactStore[u.id] = { ...(contactStore[u.id] || {}), ...u };
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect && retryCount < 6) {
        setTimeout(() => startBot(retryCount + 1), 6000);
      }
      return;
    }

    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp successfully!');
      console.log('   Owner can now send "export" to themselves.');
    }

    // Pairing Code Request with delays
    if (!sock.authState?.creds?.registered && (connection === 'connecting' || !!qr)) {
      console.log('⏳ Waiting before requesting pairing code...');
      await new Promise(r => setTimeout(r, 8000));

      let attempts = 0;
      const maxAttempts = 4;

      while (attempts < maxAttempts) {
        attempts++;
        try {
          console.log(`🔄 Pairing attempt \( {attempts}/ \){maxAttempts}...`);
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          console.log('\n================================');
          console.log('✅ PAIRING CODE:', code);
          console.log('Send this code to the account owner:');
          console.log('WhatsApp → Settings → Linked Devices → "Link with phone number instead"');
          console.log('================================\n');
          return; // Success
        } catch (err) {
          console.error(`❌ Attempt ${attempts} failed:`, err.message || err);
          if (attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 7000));
          }
        }
      }
      console.error('❌ All pairing attempts failed. Check PHONE_NUMBER or try later.');
    }
  });

  // Export command
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe !== true) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (text.trim().toLowerCase() === 'export') {
      const ownJid = msg.key.remoteJid;
      await sock.sendMessage(ownJid, { text: 'Scanning your chats for unsaved contacts…' });

      try {
        const unsaved = findUnsavedNumbers(contactStore);
        const content = buildVcf(unsaved);
        const count = unsaved.length;

        if (!count) {
          await sock.sendMessage(ownJid, { text: 'No unsaved contacts found!' });
          return;
        }

        await sock.sendMessage(ownJid, {
          document: Buffer.from(content, 'utf-8'),
          fileName: 'MATCH-contacts.vcf',
          mimetype: 'text/vcard',
        });
        await sock.sendMessage(ownJid, {
          text: `✅ Found \( {count} unsaved contact(s)! Tap the file above to import as MATCH 1– \){count}.`,
        });
      } catch (err) {
        console.error('Export failed:', err);
        await sock.sendMessage(ownJid, { text: 'Export failed — check logs.' });
      }
    }
  });
}

startBot().catch((err) => console.error('Failed to start bot:', err));

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
