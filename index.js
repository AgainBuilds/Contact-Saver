/**
 * MATCH Contact Bot (Fixed for Railway + Pairing Issues)
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
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('MATCH Contact Bot is running.\n');
}).listen(PORT, () => console.log(`Healthcheck server listening on port ${PORT}`));

const contactStore = {};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  if (!PHONE_NUMBER) {
    console.error('\n❌ Set the PHONE_NUMBER environment variable (international format, digits only) and restart.\n');
    process.exit(1);
  }

  sock.ev.on('creds.update', saveCreds);

  // Contact store management
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
      console.log(`Connection closed (code: ${statusCode || 'unknown'}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      }
      return;
    } 

    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp. Bot is live!');
      console.log('   Message yourself "export" to generate MATCH contacts.');
    }

    // Pairing Code with retry (fixes Connection Closed)
    if (!sock.authState?.creds?.registered && (connection === 'connecting' || !!qr)) {
      let attempts = 0;
      const maxAttempts = 3;

      const tryPairing = async () => {
        try {
          console.log(`🔄 Requesting pairing code (attempt \( {attempts + 1}/ \){maxAttempts})...`);
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          console.log('\n================================');
          console.log('✅ PAIRING CODE:', code);
          console.log('On your phone:');
          console.log('WhatsApp → Settings → Linked Devices → Link a Device');
          console.log('→ "Link with phone number instead" → enter the code');
          console.log('================================\n');
          return true;
        } catch (err) {
          attempts++;
          console.error(`❌ Pairing attempt ${attempts} failed:`, err.message || err);
          if (attempts < maxAttempts) {
            console.log(`Retrying in 4 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 4000));
            return tryPairing();
          }
          console.error('❌ All pairing attempts failed.');
          return false;
        }
      };

      await tryPairing();
    }
  });

  // Export command handler
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
          await sock.sendMessage(ownJid, { text: 'No unsaved contacts found — everything is already saved!' });
          return;
        }

        await sock.sendMessage(ownJid, {
          document: Buffer.from(content, 'utf-8'),
          fileName: 'MATCH-contacts.vcf',
          mimetype: 'text/vcard',
        });
        await sock.sendMessage(ownJid, {
          text: `✅ Done! Found \( {count} unsaved contact(s). Tap the file to import as MATCH 1– \){count}.`,
        });
      } catch (err) {
        console.error('Export failed:', err);
        await sock.sendMessage(ownJid, { text: 'Something went wrong — check server logs.' });
      }
    }
  });
}

startBot().catch((err) => console.error('Failed to start bot:', err));

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
