/**
 * MATCH Contact Bot - Super Stable Version
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
    });

    if (!PHONE_NUMBER) {
      console.error('\n❌ Set PHONE_NUMBER env var!\n');
      process.exit(1);
    }

    sock.ev.on('creds.update', saveCreds);

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
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed. Reconnecting:', shouldReconnect);
        if (shouldReconnect) setTimeout(() => startBot(), 5000);
      } else if (connection === 'open') {
        console.log('✅ Bot is live and connected!');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe !== true) return;

      let text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.text || '';
      if (text.trim().toLowerCase() === 'export') {
        const ownJid = msg.key.remoteJid;
        await sock.sendMessage(ownJid, { text: '🔍 Scanning...' });

        try {
          const unsaved = findUnsavedNumbers(contactStore);
          const content = buildVcf(unsaved);
          if (unsaved.length === 0) {
            await sock.sendMessage(ownJid, { text: 'No unsaved contacts found!' });
            return;
          }
          await sock.sendMessage(ownJid, {
            document: Buffer.from(content, 'utf-8'),
            fileName: 'MATCH-contacts.vcf',
            mimetype: 'text/vcard',
          });
          await sock.sendMessage(ownJid, { text: `✅ Exported ${unsaved.length} contacts!` });
        } catch (err) {
          console.error('Export error:', err);
          await sock.sendMessage(ownJid, { text: '❌ Export failed.' });
        }
      }
    });

  } catch (err) {
    console.error('Critical startup error:', err);
  }
}

startBot().catch((err) => console.error('Failed to start bot:', err));

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
