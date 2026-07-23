/**
 * contacts.js - Improved unsaved contact detection for MATCH Contact Bot
 */

function normalizeJid(jid) {
  return jid ? jid.split('@')[0].replace(/[^0-9]/g, '') : '';
}

function isPhoneNumberJid(jid) {
  return jid && jid.endsWith('@s.whatsapp.net');
}

function findUnsavedNumbers(chatStore, contactStore) {
  const unsaved = [];
  const seenNumbers = new Set();

  console.log(`[DEBUG] Total chats in store: ${chatStore.size} | Contacts in store: ${Object.keys(contactStore).length}`);

  for (const jid of chatStore) {
    if (!isPhoneNumberJid(jid)) continue;

    const number = normalizeJid(jid);
    if (!number || seenNumbers.has(number)) continue;
    seenNumbers.add(number);

    const contact = contactStore[jid] || contactStore[`${number}@s.whatsapp.net`] || {};

    // Collect all possible display names WhatsApp/Baileys might provide
    const possibleNames = [
      contact.name,
      contact.notify,
      contact.pushname,
      contact.verifiedName,
      contact.shortName
    ].filter(Boolean).map(n => n.trim());

    let displayName = possibleNames[0] || '';

    const numberWithPlus = `+${number}`;
    const isNumberLike = /^[\+]?[\d\s\-\(\)]{7,}$/.test(displayName);

    // Strict unsaved check
    const isUnsaved = !displayName || 
                     displayName === numberWithPlus || 
                     displayName === number ||
                     isNumberLike ||
                     possibleNames.some(name => name === numberWithPlus || name === number);

    if (isUnsaved) {
      unsaved.push({
        jid,
        number,
        displayName: displayName || '(no name)'
      });
    } else {
      console.log(`[DEBUG] SAVED: ${jid} → ${displayName}`);
    }
  }

  console.log(`[DEBUG] Found ${unsaved.length} unsaved contacts.`);
  return unsaved;
}

function buildVcf(unsaved) {
  let vcfContent = '';
  unsaved.forEach((contact, index) => {
    const tvName = `TV ${index + 1}`;
    vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:\( {tvName}\nTEL;type=CELL: \){contact.number}\nEND:VCARD\n`;
  });
  return vcfContent;
}

module.exports = { findUnsavedNumbers, buildVcf };
