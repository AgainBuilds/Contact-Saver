/**
 * contacts.js - Improved unsaved contact detection for MATCH Contact Bot
 */

function normalizeJid(jid) {
  return jid ? jid.split('@')[0].replace(/[^0-9]/g, '') : '';
}

function isPhoneNumberJid(jid) {
  // Accept both classic JIDs (@s.whatsapp.net) and WhatsApp's newer
  // privacy-mode "linked ID" JIDs (@lid). Chats using @lid were being
  // silently skipped before, which could hide unsaved contacts entirely.
  return jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

// Only a contact.name (synced from your phone's address book) proves
// YOU have actually saved this person. notify/pushname/verifiedName are
// set by the OTHER person themselves and say nothing about whether you
// saved them — a stranger who set their own display name still looks
// "named" but is not a saved contact. We keep them out of the identity
// check for that reason; they're still shown in the debug log for
// visibility.
function findUnsavedNumbers(chatStore, contactStore) {
  const unsaved = [];
  const seenNumbers = new Set();

  console.log(`[DEBUG] Total chats in store: ${chatStore.size} | Contacts in store: ${Object.keys(contactStore).length}`);

  for (const jid of chatStore) {
    if (!isPhoneNumberJid(jid)) {
      console.log(`[DEBUG] SKIPPED (not a phone/lid jid): ${jid}`);
      continue;
    }

    const number = normalizeJid(jid);
    if (!number || seenNumbers.has(number)) continue;
    seenNumbers.add(number);

    const contact =
      contactStore[jid] ||
      contactStore[`${number}@s.whatsapp.net`] ||
      contactStore[`${number}@lid`] ||
      {};

    const savedName = (contact.name || '').trim();
    const otherNames = [contact.notify, contact.pushname, contact.verifiedName, contact.shortName]
      .filter(Boolean)
      .map((n) => n.trim());

    const numberWithPlus = `+${number}`;
    const isNumberLike = (val) => /^[\+]?[\d\s\-\(\)]{7,}$/.test(val);

    // Unsaved = no real address-book name, OR the address-book name is
    // itself just the raw number.
    const isUnsaved = !savedName || savedName === numberWithPlus || savedName === number || isNumberLike(savedName);

    console.log(
      `[DEBUG] jid=${jid} number=${number} contact.name="${contact.name || ''}" other=${JSON.stringify(otherNames)} -> ${isUnsaved ? 'UNSAVED' : 'SAVED'}`
    );

    if (isUnsaved) {
      unsaved.push({
        jid,
        number,
        displayName: savedName || otherNames[0] || '(no name)',
      });
    }
  }

  console.log(`[DEBUG] Found ${unsaved.length} unsaved contacts.`);
  return unsaved;
}

function buildVcf(unsaved) {
  let vcfContent = '';
  unsaved.forEach((contact, index) => {
    const tvName = `TV ${index + 1}`;
    vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:${tvName}\nTEL;type=CELL:${contact.number}\nEND:VCARD\n`;
  });
  return vcfContent;
}

module.exports = { findUnsavedNumbers, buildVcf };
