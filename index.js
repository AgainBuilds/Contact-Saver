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
const { findUnsavedNumbers, buildVcf } = require('./contacts');

const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const PHONE_NUMBER = process.env.PHONE_NUMBER; // e.g. "2348012345678"

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false, // we use pairing code instead of QR
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

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp. Bot is live and running in the background.');
      console.log('   Message yourself the word "export" any time to get the MATCH contact list.');
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
          fileName: 'MATCH-contacts.vcf',
          mimetype: 'text/vcard',
        });
        await sock.sendMessage(ownJid, {
          text: `Done! Found ${vcf.count} unsaved contact(s), labeled MATCH 1–${vcf.count}. Tap the file above to import.`,
        });
      } catch (err) {
        console.error('Export failed:', err);
        await sock.sendMessage(ownJid, { text: 'Something went wrong scanning contacts — check the logs.' });
      }
    }
  });
}

/**
 * Scans the live contact store, finds unsaved numbers, and builds the
 * .vcf file. Uses the tested logic in contacts.js.
 */
async function buildUnsavedContactsVcf(sock) {
  const contacts = sock.store?.contacts || {};
  const unsaved = findUnsavedNumbers(contacts);
  const content = buildVcf(unsaved);
  return { content, count: unsaved.length };
}

startBot().catch((err) => console.error('Failed to start bot:', err));
