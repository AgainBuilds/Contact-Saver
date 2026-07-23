/**
 * MATCH Contact Bot - Final Fixed Version
 * For WhatsApp TV / Channel Owners
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
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  if (!PHONE_NUMBER) {
    console.error('\n❌ Set the PHONE_NUMBER environment variable (e.g. 2348012345678) and restart.\n');
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
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) setTimeout(() => startBot(), 5000);
    } else if (connection === 'open') {
      console.log('✅ Bot is live and connected!');
    }
  });

  // Export Handler
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe !== true) return;

    let text = msg.message.conversation || 
               msg.message.extendedTextMessage?.text || 
               msg.message.text || '';

    console.log('Received self message:', text.trim());

    if (text.trim().toLowerCase() === 'export') {
      const ownJid = msg.key.remoteJid;
      console.log('Export command detected! Starting scan...');

      await sock.sendMessage(ownJid, { text: '🔍 Scanning all chats for unsaved contacts...' });

      try {
        const unsaved = findUnsavedNumbers(contactStore);
        const content = buildVcf(unsaved);
        const count = unsaved.length;

        console.log(`Found ${count} unsaved contacts`);

        if (count === 0) {
          await sock.sendMessage(ownJid, { text: 'No unsaved contacts found. Everything is already saved!' });
          return;
        }

        await sock.sendMessage(ownJid, {
          document: Buffer.from(content, 'utf-8'),
          fileName: 'MATCH-contacts.vcf',
          mimetype: 'text/vcard',
        });

        await sock.sendMessage(ownJid, {
          text: `✅ Done! Found and exported ${count} unsaved contact(s).\nLabeled MATCH 1 to MATCH ${count}.\nTap the file to import.`,
        });
      } catch (err) {
        console.error('Export error:', err);
        await sock.sendMessage(ownJid, { text: '❌ Export failed. Check server logs.' });
      }
    }
  });
}

startBot().catch((err) => console.error('Failed to start bot:', err));

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
