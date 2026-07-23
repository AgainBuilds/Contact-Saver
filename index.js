/**
 * MATCH Contact Bot (Fixed for pairing + Railway)
 * ... (rest of your header)
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
    console.error('\nSet PHONE_NUMBER env var (international format, digits only) and restart.\n');
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
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        // Small delay to avoid tight loops
        setTimeout(() => startBot(), 2000);
      }
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp. Bot is live.');
      console.log('   Send "export" to yourself to generate MATCH contacts.');
    }

    // === Pairing code (critical fix) ===
    if (!sock.authState.creds.registered && (connection === 'connecting' || !!qr)) {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('\n================================');
        console.log(' PAIRING CODE:', code);
        console.log(' WhatsApp > Settings > Linked Devices > Link a Device');
        console.log(' > "Link with phone number instead" > enter code');
        console.log('================================\n');
      } catch (err) {
        console.error('Failed to request pairing code:', err.message || err);
      }
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
        const vcf = await buildUnsavedContactsVcf(sock);
        if (!vcf.count) {
          await sock.sendMessage(ownJid, { text: 'No unsaved contacts found!' });
          return;
        }
        await sock.sendMessage(ownJid, {
          document: Buffer.from(vcf.content, 'utf-8'),
          fileName: 'MATCH-contacts.vcf',
          mimetype: 'text/vcard',
        });
        await sock.sendMessage(ownJid, {
          text: `✅ Found ${vcf.count} unsaved contact(s). Tap the file to import!`,
        });
      } catch (err) {
        console.error('Export failed:', err);
        await sock.sendMessage(ownJid, { text: 'Export failed — check logs.' });
      }
    }
  });
}

async function buildUnsavedContactsVcf(sock) {
  const unsaved = findUnsavedNumbers(contactStore);
  const content = buildVcf(unsaved);
  return { content, count: unsaved.length };
}

startBot().catch((err) => console.error('Failed to start bot:', err));

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
