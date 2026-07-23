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
 * TV 1, TV 2, TV 3... and send back a ready-to-import .vcf file
 * right there in the chat.
 *
 * SETUP:
 *   1. npm install
 *   2. Set the PHONE_NUMBER env var to the WhatsApp account's own
 *      number, in international format with no + or spaces, e.g.
 *      2348012345678
 *   3. npm start
 *   4. The console will print a pairing code. The account owner opens
 *      WhatsApp on their phone > Settings > Linked Devices > Link a
 *      Device > "Link with phone number instead" > enters that code.
 *   5. Leave it running (deploy to Railway/Render for 24/7 uptime).
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
const PHONE_NUMBER = process.env.PHONE_NUMBER; // e.g. "2348012345678"

// --- Railway needs something listening on $PORT, or its healthcheck ---
// --- marks the deploy unhealthy and restarts/kills the container.  ---
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MATCH Contact Bot is running.\n');
  })
  .listen(PORT, () => console.log(`Healthcheck server listening on port ${PORT}`));

// --- Baileys no longer ships an internal contact store (sock.store  ---
// --- is undefined in current versions), so we build our own from   ---
// --- the events it emits.                                          ---
const contactStore = {};
// Every 1:1 chat JID we know about — this is what catches someone who
// only ever messaged you, since they may never trigger a contacts event.
const chatStore = new Set();

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false, // we use pairing code instead of QR
    syncFullHistory: true, // without this, only chats from the moment we connect get pushed to us
  });

  // --- Pairing code flow (no QR, no screen share needed) ---
  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) {
      console.error(
        '\nSet the PHONE_NUMBER environment variable (international format, digits only, e.g. 2348012345678) and restart.\n'
      );
      process.exit(1);
    }
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('\n================================');
        console.log(' PAIRING CODE:', code);
        console.log(' On the WhatsApp account owner\'s phone:');
        console.log(' Settings > Linked Devices > Link a Device');
        console.log(' > "Link with phone number instead" > enter this code');
        console.log('================================\n');
      } catch (err) {
        console.error('Failed to request pairing code:', err);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  // Keep our own contact map up to date (replaces the removed sock.store)
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

  // Track every known chat JID — catches numbers that only ever messaged
  // you, which never show up via contacts.* events alone.
  sock.ev.on('chats.set', ({ chats }) => {
    for (const c of chats) chatStore.add(c.id);
  });
  sock.ev.on('chats.upsert', (chats) => {
    for (const c of chats) chatStore.add(c.id);
  });
  // One-time payload WhatsApp sends after linking with the account's
  // existing chats/contacts/messages — this is what actually surfaces
  // chats that existed before the bot connected.
  sock.ev.on('messaging-history.set', ({ chats, contacts }) => {
    for (const c of chats || []) chatStore.add(c.id);
    for (const c of contacts || []) contactStore[c.id] = { ...(contactStore[c.id] || {}), ...c };
    console.log(`History sync received: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts.`);
  });
  // Also track chat JIDs from any message we happen to see, as a fallback.
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      if (m.key?.remoteJid) chatStore.add(m.key.remoteJid);
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp. Bot is live and running in the background.');
      console.log('   Message yourself the word "export" any time to get the contact list.');
    }
  });

  // --- Command listener: trigger export by messaging yourself "export" ---
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe !== true) return; // only the owner's own messages trigger it

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    if (text.trim().toLowerCase() === 'export') {
      const ownJid = msg.key.remoteJid;
      await sock.sendMessage(ownJid, { text: 'Scanning your chats for unsaved contacts…' });
      try {
        const vcf = await buildUnsavedContactsVcf(sock);
        if (!vcf.count) {
          await sock.sendMessage(ownJid, { text: 'No unsaved contacts found — everything is already saved!' });
          return;
        }
        await sock.sendMessage(ownJid, {
          document: Buffer.from(vcf.content, 'utf-8'),
          fileName: 'TV-contacts.vcf',
          mimetype: 'text/vcard',
        });
        await sock.sendMessage(ownJid, {
          text: `Done! Found ${vcf.count} unsaved contact(s), labeled TV 1–${vcf.count}. Tap the file above to import.`,
        });
      } catch (err) {
        console.error('Export failed:', err);
        await sock.sendMessage(ownJid, { text: 'Something went wrong scanning contacts — check the logs.' });
      }
    }
  });
}

/**
 * Scans the live chat + contact stores, finds unsaved numbers, and
 * builds the .vcf file. Uses the tested logic in contacts.js.
 */
async function buildUnsavedContactsVcf(sock) {
  const unsaved = findUnsavedNumbers(chatStore, contactStore);
  const content = buildVcf(unsaved);
  return { content, count: unsaved.length };
}

startBot().catch((err) => console.error('Failed to start bot:', err));

// Don't let one bad event silently crash the whole container
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
