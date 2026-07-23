/**
 * MATCH Contact Bot - FINAL STABLE VERSION
 * For WhatsApp TV / Channels
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
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('MATCH Contact Bot is running.\n');
}).listen(PORT, () => console.log(`Healthcheck server listening on port ${PORT}`));

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
      browser: ["MATCH Bot", "Chrome", "1.0.0"]
    });

    if (!PHONE_NUMBER) {
      console.error('\n❌ Set PHONE_NUMBER env var!\n');
      process.exit(1);
    }

    sock.ev.on('creds.update', saveCreds);

    // Contacts
    sock.ev.on('contacts.upsert', (contacts) => contacts.forEach(c => contactStore[c.id] = c));
    sock.ev.on('contacts.set', ({ contacts }) => contacts.forEach(c => contactStore[c.id] = c));
    sock.ev.on('contacts.update', (updates) => updates.forEach(u => contactStore[u.id] = { ...(contactStore[u.id] || {}), ...u }));

    // Pairing Code
    if (!state.creds.registered) {
      console.log('Waiting before pairing...');
      await new Promise(r => setTimeout(r, 6000));

      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('\n================================');
        console.log('PAIRING CODE:', code);
        console.log('Enter this in WhatsApp → Linked Devices → Link with phone number');
        console.log('================================\n');
      } catch (e) {
        console.error('Pairing failed:', e.message);
      }
    }

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        console.log('✅ Bot connected successfully!');
      }
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed. Reconnecting:', shouldReconnect);
        if (shouldReconnect) setTimeout(() => startBot(), 5000);
      }
    });

    // Export Command
    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe !== true) return;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (text.trim().toLowerCase() !== 'export') return;

      const ownJid = msg.key.remoteJid;
      await sock.sendMessage(ownJid, { text: '🔍 Scanning unsaved contacts...' });

      try {
        const unsaved = findUnsavedNumbers(contactStore);
        const content = buildVcf(unsaved);
        const count = unsaved.length;

        if (count === 0) {
          await sock.sendMessage(ownJid, { text: 'No unsaved contacts found!' });
          return;
        }

        await sock.sendMessage(ownJid, {
          document: Buffer.from(content, 'utf-8'),
          fileName: 'MATCH-contacts.vcf',
          mimetype: 'text/vcard'
        });
        await sock.sendMessage(ownJid, { text: `✅ Exported \( {count} unsaved contacts as MATCH 1- \){count}!` });
      } catch (err) {
        console.error('Export error:', err);
        await sock.sendMessage(ownJid, { text: '❌ Export failed.' });
      }
    });

  } catch (err) {
    console.error('Startup error:', err);
    setTimeout(startBot, 8000);
  }
}

startBot().catch(err => console.error('Fatal error:', err));

process.on('unhandledRejection', err => console.error('Rejection:', err));
process.on('uncaughtException', err => console.error('Exception:', err));
