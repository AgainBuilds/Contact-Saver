/**
 * accountSession.js
 * ------------------
 * Creates and runs ONE WhatsApp account's Baileys connection — its own
 * auth state, its own chat/contact store, its own pairing-code flow,
 * its own reconnect handling, and its own "export" command listener.
 *
 * This is the EXACT same logic the single-account bot used to run
 * inline in index.js — pairing-once-no-retry, syncFullHistory:false,
 * markOnlineOnConnect:false, the listener-cleanup-on-reconnect fix, the
 * @lid resolution + contactStore-mirroring fix — just extracted into a
 * factory so it can be instantiated once per connected account instead
 * of hardcoded to one. The owner's account and every "connect"-ed
 * member account are each their own independent instance of this: own
 * auth_info_<id>/ folder, own store_<id>.json, own in-memory chat/
 * contact maps. Nothing is shared between instances, so one member's
 * data can never leak into another's export.
 *
 * Only the caller (index.js) decides who gets the extra "connect"
 * command — via the optional `handleExtraCommand` hook, wired up ONLY
 * for the owner's instance. A member's instance is simply never given
 * that hook, so there is no code path in a member's session that could
 * ever reach "connect" — it isn't a permission check that could be
 * bypassed, it's a listener that was never attached.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { findUnsavedNumbers, buildVcf } from './contacts.js';

/**
 * @param {object} opts
 * @param {string} opts.accountId - unique id; used to name this account's auth folder/store file
 * @param {string} opts.phoneNumber - international format, digits only (e.g. "2348121081916")
 * @param {string} opts.baseDir - directory under which auth_info_<id>/ and store_<id>.json live
 * @param {(code: string) => any} opts.onPairingCode - called once a pairing code is generated; caller decides where it goes (console, a WhatsApp message, etc.)
 * @param {(err?: Error) => any} [opts.onPairingFailure] - called if the request throws, or if the session closes before pairing ever completed
 * @param {() => any} [opts.onOpen] - called every time the connection reaches 'open' (initial pairing AND every later reconnect)
 * @param {(text: string, ownJid: string, sock: any) => Promise<boolean>} [opts.handleExtraCommand] - checked BEFORE the built-in "export" match; return true to mean "I handled this, don't also check for export"
 */
export function createAccountSession({
  accountId,
  phoneNumber,
  baseDir,
  onPairingCode,
  onPairingFailure,
  onOpen,
  handleExtraCommand,
}) {
  const AUTH_FOLDER = path.join(baseDir, `auth_info_${accountId}`);
  const STORE_FILE = path.join(baseDir, `store_${accountId}.json`);

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
  const chatStore = loaded.chats;
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
        console.error(`[${accountId}] Failed to persist store:`, err);
      }
    }, 2000);
  }

  function linkLidAndPn(lidJid, pnJid) {
    if (!lidJid || !pnJid) return;
    if (lidMap[lidJid] === pnJid && lidMap[pnJid] === lidJid) return;
    lidMap[lidJid] = pnJid;
    lidMap[pnJid] = lidJid;
    saveStoreDebounced();
  }

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
    if (pn && lid) {
      linkLidAndPn(lid, pn);
      const otherJid = c.id === pn ? lid : pn;
      contactStore[otherJid] = { ...(contactStore[otherJid] || {}), ...c };
    }
  }

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

  async function buildUnsavedContactsVcf(sock) {
    async function resolvePnForLid(lidJid) {
      if (lidMap[lidJid]) return lidMap[lidJid];
      try {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
        if (pn) {
          const pnJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
          linkLidAndPn(lidJid, pnJid);
          return pnJid;
        }
      } catch (err) {
        console.log(`[${accountId}] [DEBUG] official lidMapping lookup failed for ${lidJid}:`, err?.message || err);
      }
      return undefined;
    }
    const unsaved = await findUnsavedNumbers(chatStore, contactStore, resolvePnForLid);
    const content = buildVcf(unsaved);
    return { content, count: unsaved.length, skippedUnresolvedLid: unsaved.skippedUnresolvedLid || 0 };
  }

  let sock; // reassigned on every (re)connect below; getSock() always reads the live value

  async function start() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      syncFullHistory: false, // avoid OOM on pairing — see index.js header for why
      markOnlineOnConnect: false, // so phone notifications for replies actually show up
    });

    let codeRequested = false;
    async function requestPairingCodeOnce() {
      if (codeRequested) return;
      codeRequested = true;
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        await onPairingCode?.(code);
      } catch (err) {
        console.error(`[${accountId}] Failed to request pairing code:`, err);
        await onPairingFailure?.(err);
      }
    }

    if (!sock.authState.creds.registered) {
      if (!phoneNumber) {
        console.error(`[${accountId}] No phone number provided — cannot pair.`);
        return;
      }
      setTimeout(requestPairingCodeOnce, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

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

    sock.ev.on('chats.set', ({ chats }) => {
      for (const c of chats) chatStore.add(c.id);
      saveStoreDebounced();
    });
    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) chatStore.add(c.id);
      saveStoreDebounced();
    });
    sock.ev.on('messaging-history.set', ({ chats, contacts }) => {
      for (const c of chats || []) chatStore.add(c.id);
      for (const c of contacts || []) {
        contactStore[c.id] = { ...(contactStore[c.id] || {}), ...c };
        harvestLidMapFromContact(contactStore[c.id]);
      }
      console.log(`[${accountId}] History sync received: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts.`);
      saveStoreDebounced();
    });
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) {
        if (m.key?.remoteJid) chatStore.add(m.key.remoteJid);
        harvestLidMapFromMessageKey(m.key);
      }
      saveStoreDebounced();
    });
    sock.ev.on('lid-mapping.update', (update) => {
      try {
        const entries = Array.isArray(update) ? update : [update];
        for (const u of entries) {
          if (u?.lid && u?.pn) linkLidAndPn(u.lid, u.pn);
        }
      } catch (err) {
        console.error(`[${accountId}] Failed to process lid-mapping.update:`, err);
      }
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const wasRegistered = sock.authState.creds.registered;
        const shouldReconnect =
          wasRegistered && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log(`[${accountId}] Connection closed. Reconnecting:`, shouldReconnect);
        sock.ev.removeAllListeners();
        if (shouldReconnect) {
          start();
        } else if (!wasRegistered) {
          console.error(`[${accountId}] Connection closed before pairing completed. Not auto-restarting.`);
          onPairingFailure?.(new Error('Closed before pairing completed'));
        }
      } else if (connection === 'open') {
        console.log(`[${accountId}] Connected to WhatsApp.`);
        onOpen?.();
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe !== true) return; // only this account's own messages trigger commands

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';
      const ownJid = msg.key.remoteJid;
      const trimmed = text.trim();

      if (handleExtraCommand) {
        const handled = await handleExtraCommand(trimmed, ownJid, sock);
        if (handled) return;
      }

      if (trimmed.toLowerCase() === 'export') {
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
                ? ` (Skipped ${vcf.skippedUnresolvedLid} chat(s) with no linkable phone number yet — try "export" again later.)`
                : ''
            }`,
          });
        } catch (err) {
          console.error(`[${accountId}] Export failed:`, err);
          await sock.sendMessage(ownJid, { text: 'Something went wrong scanning contacts — check the logs.' });
        }
      }
      // Anything else (not "export", not matched by handleExtraCommand)
      // is silently ignored — this account's self-chat is also just a
      // normal chat, and we don't want to reply to unrelated messages.
    });
  }

  return { start, getSock: () => sock };
}
