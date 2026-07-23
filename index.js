/**
 * MATCH Contact Bot - Stable Version for Railway
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const path = require("path");
const http = require("http");

const { findUnsavedNumbers, buildVcf } = require("./contacts");

const AUTH_FOLDER = path.join(__dirname, "auth_info");
const PHONE_NUMBER = process.env.PHONE_NUMBER?.trim();

const PORT = process.env.PORT || 8080;

http
  .createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain",
    });
    res.end("MATCH Contact Bot is running.\n");
  })
  .listen(PORT, () => {
    console.log(`Healthcheck server listening on port ${PORT}`);
  });

const contactStore = {};

async function startBot() {
  try {
    if (!PHONE_NUMBER) {
      throw new Error(
        "PHONE_NUMBER environment variable is missing."
      );
    }

    console.log("Loading auth state...");

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_FOLDER);

    console.log("Fetching latest WhatsApp version...");

    const { version } =
      await fetchLatestBaileysVersion();

    console.log("Creating socket...");

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({
        level: "info",
      }),
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    // Generate pairing code on first login
    if (!state.creds.registered) {
      console.log("Requesting pairing code...");

      try {
        const code = await sock.requestPairingCode(
          PHONE_NUMBER
        );

        console.log("");
        console.log("==============================");
        console.log("PAIRING CODE:");
        console.log(code);
        console.log("==============================");
        console.log("");
      } catch (err) {
        console.error(
          "Failed to request pairing code:",
          err
        );
      }
    }

    sock.ev.on("connection.update", (update) => {
      console.log("Connection Update:", update);

      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        console.log("✅ Bot is live and connected!");
      }

      if (connection === "close") {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut;

        console.log(
          "Connection closed. Reconnect:",
          shouldReconnect
        );

        if (shouldReconnect) {
          setTimeout(startBot, 5000);
        }
      }
    });

    // Contact Store

    sock.ev.on("contacts.upsert", (contacts) => {
      contacts.forEach((c) => {
        contactStore[c.id] = c;
      });
    });

    sock.ev.on("contacts.set", ({ contacts }) => {
      contacts.forEach((c) => {
        contactStore[c.id] = c;
      });
    });

    sock.ev.on("contacts.update", (updates) => {
      updates.forEach((u) => {
        contactStore[u.id] = {
          ...(contactStore[u.id] || {}),
          ...u,
        };
      });
    });

    // Listen for export command

    sock.ev.on("messages.upsert", async ({ messages }) => {
      const msg = messages[0];

      if (!msg?.message) return;
      if (!msg.key.fromMe) return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (text.trim().toLowerCase() !== "export") return;

      const ownJid = msg.key.remoteJid;

      try {
        await sock.sendMessage(ownJid, {
          text: "🔍 Scanning your chats...",
        });

        const unsaved =
          findUnsavedNumbers(contactStore);

        if (!unsaved.length) {
          await sock.sendMessage(ownJid, {
            text: "No unsaved contacts found.",
          });
          return;
        }

        await sock.sendMessage(ownJid, {
          document: Buffer.from(
            buildVcf(unsaved),
            "utf8"
          ),
          fileName: "MATCH-contacts.vcf",
          mimetype: "text/vcard",
        });

        await sock.sendMessage(ownJid, {
          text: `✅ Done! Found ${unsaved.length} unsaved contact(s).`,
        });
      } catch (err) {
        console.error("Export failed:", err);

        await sock.sendMessage(ownJid, {
          text: "❌ Export failed. Check Railway logs.",
        });
      }
    });
  } catch (err) {
    console.error("Failed to start bot:", err);

    setTimeout(startBot, 5000);
  }
}

startBot();

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
