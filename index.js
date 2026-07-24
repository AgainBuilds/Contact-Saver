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
 * Built for Baileys 7.x, which ships as ESM only and finalizes
 * WhatsApp's LID (Local Identifier) privacy system — see the comments
 * above the lid-handling functions below for what that means for
 * contact detection.
 *
 * SETUP:
 *   1. npm install
 *   2. Set the PHONE_NUMBER env var to the WhatsApp account's own
 *      number, in international format with no + or spaces, e.g.
 *      2348012345678
 *   3. npm start
 *   4. The console prints an 8-character pairing code ONCE. Before
 *      that happens, get your phone ready: WhatsApp > Settings >
 *      Linked Devices > Link a Device > "Link with phone number
 *      instead" > sitting on the empty code-entry screen, country set
 *      to Nigeria (+234). The moment the code appears in the log, type
 *      it in — these expire in well under a minute, and this bot does
 *      NOT auto-retry the request (repeated pairing requests get
 *      flagged by WhatsApp and can get the number's session hard-
 *      closed, which shows up on the phone as "Couldn't link device").
 *   5. Leave it running (deploy to Railway/Render for 24/7 uptime).
 *
 *   NOTE: if you need a fresh pairing code (e.g. you unlinked the
 *   device from WhatsApp, or auth got stale), delete the auth_info/
 *   folder before restarting — otherwise the bot thinks it's already
 *   registered and won't print a new code. On a fresh Railway
 *   environment (no volume) this is already true on every deploy.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import { findUnsavedNumbers, buildVcf } from './contacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// NOTE: no persistent volume yet, so these reset on every redeploy.
// Fine for testing the detection logic in one continuous run; once
// you're on a plan with a volume, point these at the mounted path.
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const STORE_FILE = path.join(__dirname, 'store.json');
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
// --- the events it emits. Persisted to disk because WhatsApp only  ---
// --- sends the full messaging-history.set sync once, right after  ---
// --- the initial pairing — not on every reconnect. Without         ---
// --- persistence, a restart wipes out everything except chats/     ---
// --- contacts seen live after that restart.                        ---
//
// We also persist our own lid <-> phone-number JID map, as a fast,
// synchronous fallback ALONGSIDE Baileys' own official one
// (sock.signalRepository.lidMapping, added as part of the 7.x LID
// system finalization). See contacts.js for how the two are combined.
function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return {
      chats: new Set(data.chats || []),
      contacts: data.contacts || {},
      lidMap: data.lidMap || {},
    };
  } catch {
    return { chats: new Set(), contacts: {}, lidMap: {} };
  }
}

const loaded = loadStore();
const contactStore = loaded.contacts;
// Every 1:1 chat JID we know about — this is what catches someone who
// only ever messaged you, since they may never trigger a contacts event.
const chatStore = loaded.chats;
// Bidirectional: lidMap[someLidJid] = pnJid AND lidMap[somePnJid] = lidJid
const lidMap = loaded.lidMap;

let saveTimer = null;
function saveStoreDebounced() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(
        STORE_FILE,
        JSON.stringify({ chats: [...chatStore], contacts: contactStore, lidMap })
      );
    } catch (err) {
      console.error('Failed to persist store:', err);
    }
  }, 2000); // batch rapid-fire events into one write
}

function linkLidAndPn(lidJid, pnJid) {
  if (!lidJid || !pnJid) return;
  if (lidMap[lidJid] === pnJid && lidMap[pnJid] === lidJid) return; // already linked
  lidMap[lidJid] = pnJid;
  lidMap[pnJid] = lidJid;
  saveStoreDebounced();
}

// Pulls a lid<->pn pairing out of a Contact object. As of Baileys 7.x
// the Contact type has an `id` field (either a @lid or @s.whatsapp.net
// JID) plus whichever of `phoneNumber` / `lid` is the OTHER form — e.g.
// if `id` is a @lid, `phoneNumber` holds the real number, and vice
// versa (per the 7.x migration notes).
function harvestLidMapFromContact(c) {
  if (!c) return;
  const idIsLid = c.id && c.id.endsWith('@lid');
  const idIsPn = c.id && c.id.endsWith('@s.whatsapp.net');
  const pn = idIsPn
    ? c.id
    : c.phoneNumber
    ? c.phoneNumber.includes('@')
      ? c.phoneNumber
      : `${c.phoneNumber}@s.whatsapp.net`
    : undefined;
  const lid = idIsLid ? c.id : c.lid ? (c.lid.includes('@') ? c.lid : `${c.lid}@lid`) : undefined;
  if (pn && lid) linkLidAndPn(lid, pn);
}

// Pulls a lid<->pn pairing out of a message key when present. Baileys
// 6.8+/7.x attaches `remoteJidAlt` (DMs) / `participantAlt` (groups) —
// the alternate JID form for the same person — to messages routed
// through the lid privacy layer.
function harvestLidMapFromMessageKey(key) {
  if (!key) return;
  const pairs = [
    [key.remoteJid, key.remoteJidAlt],
    [key.participant, key.participantAlt],
  ];
  for (const [a, b] of pairs) {
    if (!a || !b) continue;
    const lid = a.endsWith('@lid') ? a : b.endsWith('@lid') ? b : undefined;
    const pn = a.endsWith('@s.whatsapp.net') ? a : b.endsWith('@s.whatsapp.net') ? b : undefined;
    if (lid && pn) linkLidAndPn(lid, pn);
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false, // we use pairing code instead of QR
    // Full history sync loads your entire WhatsApp message history into
    // memory at pairing time — easily enough to exceed a free-tier
    // memory limit and get the container OOM-killed mid-pairing. We
    // only need chat JIDs and contact names, not message content, so
    // this stays off. `messaging-history.set` still fires with chats
    // and contacts either way.
    syncFullHistory: false,
    // Without this, WhatsApp treats the linked session as "you're
    // already active elsewhere" and can suppress phone notifications
    // for messages — including the bot's own replies to "export".
    // Keeping this false is what lets your phone actually notify you
    // when the bot responds.
    markOnlineOnConnect: false,
  });

  // --- Pairing code flow (no QR, no screen share needed) ---
  // Requested EXACTLY ONCE per process run, after a short fixed delay
  // so the socket's handshake has time to get underway. No automatic
  // retry: WhatsApp treats repeated pairing-code requests for the same
  // number in a short window as suspicious and will hard-close the
  // session (a real logout, not a reconnectable network drop).
  let codeRequested = false;

  async function requestPairingCodeOnce() {
    if (codeRequested) return;
    codeRequested = true;
    try {
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      console.log('\n================================');
      console.log(' PAIRING CODE:', code);
      console.log(' On the WhatsApp account owner\'s phone:');
      console.log(' Settings > Linked Devices > Link a Device');
      console.log(' > "Link with phone number instead" > enter this code');
      console.log(' This code expires in under a minute — have the phone');
      console.log(' already sitting on the entry screen before this prints.');
      console.log('================================\n');
    } catch (err) {
      console.error(
        'Failed to request pairing code:',
        err,
        '\nNot retrying automatically — repeated requests can get the number' +
          ' temporarily blocked by WhatsApp. Wait a minute, then restart the process.'
      );
    }
  }

  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) {
      console.error(
        '\nSet the PHONE_NUMBER environment variable (international format, digits only, e.g. 2348012345678) and restart.\n'
      );
      process.exit(1);
    }
    setTimeout(requestPairingCodeOnce, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  // Keep our own contact map up to date (replaces the removed sock.store)
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      contactStore[c.id] = c;
      harvestLidMapFromContact(c);
    }
    saveStoreDebounced();
  });
  sock.ev.on('contacts.set', ({ contacts }) => {
    for (const c of contacts) {
      contactStore[c.id] = c;
      harvestLidMapFromContact(c);
    }
    saveStoreDebounced();
  });
  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) {
      contactStore[u.id] = { ...(contactStore[u.id] || {}), ...u };
      harvestLidMapFromContact(contactStore[u.id]);
    }
    saveStoreDebounced();
  });

  // Track every known chat JID — catches numbers that only ever messaged
  // you, which never show up via contacts.* events alone.
  sock.ev.on('chats.set', ({ chats }) => {
    for (const c of chats) chatStore.add(c.id);
    saveStoreDebounced();
  });
  sock.ev.on('chats.upsert', (chats) => {
    for (const c of chats) chatStore.add(c.id);
    saveStoreDebounced();
  });
  // One-time payload WhatsApp sends after linking with the account's
  // existing chats/contacts/messages — this is what actually surfaces
  // chats that existed before the bot connected. Only fires reliably
  // right after initial pairing, which is why we persist the result.
  sock.ev.on('messaging-history.set', ({ chats, contacts }) => {
    for (const c of chats || []) chatStore.add(c.id);
    for (const c of contacts || []) {
      contactStore[c.id] = { ...(contactStore[c.id] || {}), ...c };
      harvestLidMapFromContact(contactStore[c.id]);
    }
    console.log(`History sync received: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts.`);
    saveStoreDebounced();
  });
  // Also track chat JIDs from any message we happen to see, as a fallback,
  // and harvest lid<->pn pairings off the message key when present.
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      if (m.key?.remoteJid) chatStore.add(m.key.remoteJid);
      harvestLidMapFromMessageKey(m.key);
    }
    saveStoreDebounced();
  });
  // New in 7.x: WhatsApp occasionally pushes lid<->pn pairings directly.
  // The library's own docs mark this event's exact shape as a work in
  // progress ("not reported always"), so this is handled defensively —
  // if the shape doesn't match what we expect, we just learn nothing
  // from it rather than crashing.
  sock.ev.on('lid-mapping.update', (update) => {
    try {
      const entries = Array.isArray(update) ? update : [update];
      for (const u of entries) {
        if (u?.lid && u?.pn) linkLidAndPn(u.lid, u.pn);
      }
    } catch (err) {
      console.error('Failed to process lid-mapping.update:', err);
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const wasRegistered = sock.authState.creds.registered;
      const shouldReconnect =
        wasRegistered && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      // Drop every listener on this dead socket before reconnecting —
      // otherwise each reconnect stacks a fresh set of handlers on top
      // of the old ones, and things like the "export" command end up
      // firing once per accumulated listener.
      sock.ev.removeAllListeners();
      if (shouldReconnect) {
        startBot();
      } else if (!wasRegistered) {
        // Closed before pairing finished. Don't auto-restart — that
        // would silently fire another pairing-code request right
        // after this one, which is what gets a number rate-limited.
        console.error(
          'Connection closed before pairing completed. Not auto-restarting — ' +
            'restart the process manually to request a new pairing code.'
        );
      }
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
          await sock.sendMessage(ownJid, {
            text: `No unsaved contacts found — everything is already saved!${
              vcf.skippedUnresolvedLid
                ? ` (Note: ${vcf.skippedUnresolvedLid} chat(s) had no linkable phone number yet and couldn't be checked — try again later.)`
                : ''
            }`,
          });
          return;
        }
        await sock.sendMessage(ownJid, {
          document: Buffer.from(vcf.content, 'utf-8'),
          fileName: 'TV-contacts.vcf',
          mimetype: 'text/vcard',
        });
        await sock.sendMessage(ownJid, {
          text: `Done! Found ${vcf.count} unsaved contact(s), labeled TV 1–${vcf.count}. Tap the file above to import.${
            vcf.skippedUnresolvedLid
              ? ` (Skipped ${vcf.skippedUnresolvedLid} chat(s) with no linkable phone number yet — try "export" again later, they often resolve once WhatsApp syncs them.)`
              : ''
          }`,
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
 * builds the .vcf file. Uses the tested logic in contacts.js, giving
 * it both our own harvested lid<->pn map AND (as a fallback) Baileys'
 * own official lid<->pn store for resolving @lid chats.
 */
async function buildUnsavedContactsVcf(sock) {
  async function resolvePnForLid(lidJid) {
    if (lidMap[lidJid]) return lidMap[lidJid];
    try {
      // Optional chaining throughout: this API is new as of the 7.x
      // LID overhaul, and its exact shape could still shift across
      // prerelease versions — if any part of it is missing, we just
      // fall through to "unresolved" instead of throwing.
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
      if (pn) {
        const pnJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
        linkLidAndPn(lidJid, pnJid);
        return pnJid;
      }
    } catch (err) {
      console.log(`[DEBUG] official lidMapping lookup failed for ${lidJid}:`, err?.message || err);
    }
    return undefined;
  }

  const unsaved = await findUnsavedNumbers(chatStore, contactStore, resolvePnForLid);
  const content = buildVcf(unsaved);
  return { content, count: unsaved.length, skippedUnresolvedLid: unsaved.skippedUnresolvedLid || 0 };
}

startBot().catch((err) => console.error('Failed to start bot:', err));

// Don't let one bad event silently crash the whole container
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
