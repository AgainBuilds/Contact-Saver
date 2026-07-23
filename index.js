/**
 * MATCH Contact Bot
 * -------------------
 * Connects to WhatsApp via Baileys (multi-device), using a pairing code
 * so the account owner links it themselves from their own phone —
 * no QR scanning, no screen sharing needed.
 *
 * Once connected and running in the background, the owner can message
 * their OWN chat (the "Message yourself" thread) with the word:
 *
 *     export
 *
 * ...and the bot will scan all chats for "unsaved" contacts (ones
 * still showing as a raw phone number instead of a name), label them
 * MATCH 1, MATCH 2, MATCH 3... and send back a ready-to-import .vcf
 * file right there in the chat.
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
const PHONE_NUMBER = process.env.PHONE_NUMBER?.trim();

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MATCH Contact Bot is running.\n');
  })
  .listen(PORT, () => console.log(`Healthcheck server listening on port ${PORT}`));

const contactStore = {};

async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
    });

    if (!PHONE_NUMBER) {
      console.error('\nSet the PHONE_NUMBER environment variable (international format, digits only, e.g. 2348012345678) and restart.\n');
      process.exit(1);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('contacts.upsert', (contacts) => contacts.forEach((c) => (contactStore[c.id] = c)));
    sock.ev.on('contacts.set', ({ contacts }) => contacts.forEach((c) => (contactStore[c.id] = c)));
    sock.ev.on('contacts.update', (updates) =>
      updates.forEach((u) => (contactStore[u.id] = { ...(contactStore[u.id] || {}), ...u }))
    );

    if (!state.creds.registered) {
      console.log('Waiting before requesting pairing code...');
      await new Promise((r) => setTimeout(r, 3000));

      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('\n================================');
        console.log(' PAIRING CODE:', code);
        console.log(' Enter this NOW (expires in ~60s):');
        console.log(' WhatsApp > Settings > Linked Devices > Link a Device');
        console.log(' > "Link with phone number instead"');
        console.log('================================\n');
      } catch (e) {
        console.error('Pairing failed:', e.message);
      }
    }

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        console.log('✅ Connected to WhatsApp. Bot is live.');
        console.log('   Message yourself "export" any time to get the MATCH contact list.');
      }
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed. Reconnecting:', shouldReconnect);
        if (shouldReconnect) setTimeout(() => startBot(), 5000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe !== true) return;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (text.trim().toLowerCase() !== 'export') return;

      const ownJid = msg.key.remoteJid;
      await sock.sendMessage(ownJid, { text: 'Scanning your chats for unsaved contacts…' });

      try {
        const unsaved = findUnsavedNumbers(contactStore);
        const content = buildVcf(unsaved);
        const count = unsaved.length;

        if (count === 0) {
          await sock.sendMessage(ownJid, { text: 'No unsaved contacts found — everything is already saved!' });
          return;
        }

        await sock.sendMessage(ownJid, {
          document: Buffer.from(content, 'utf-8'),
          fileName: 'MATCH-contacts.vcf',
          mimetype: 'text/vcard',
        });
        await sock.sendMessage(ownJid, {
          text: `Done! Found ${count} unsaved contact(s), labeled MATCH 1–${count}. Tap the file above to import.`,
        });
      } catch (err) {
        console.error('Export error:', err);
        await sock.sendMessage(ownJid, { text: 'Something went wrong scanning contacts — check the logs.' });
      }
    });
  } catch (err) {
    console.error('Startup error:', err);
    setTimeout(startBot, 8000);
  }
}

startBot().catch((err) => console.error('Fatal error:', err));

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
