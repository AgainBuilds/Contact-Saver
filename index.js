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

let restarting = false;


// Railway health check server
http
  .createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain",
    });

    res.end("MATCH Contact Bot is running.\n");
  })
  .listen(PORT, () => {
    console.log(`Healthcheck running on port ${PORT}`);
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



    console.log("Fetching WhatsApp version...");


    const { version } =
      await fetchLatestBaileysVersion();



    console.log("Creating WhatsApp socket...");



    const sock = makeWASocket({

      version,

      auth: state,

      logger: pino({
        level: "info",
      }),

      printQRInTerminal: false,

      browser: [
        "MATCH Contact Bot",
        "Chrome",
        "1.0.0"
      ]

    });



    sock.ev.on(
      "creds.update",
      saveCreds
    );



    // Pairing code login

    if (!state.creds.registered) {

      console.log(
        "Waiting before requesting pairing code..."
      );


      await new Promise(resolve =>
        setTimeout(resolve, 5000)
      );


      try {

        const code =
          await sock.requestPairingCode(
            PHONE_NUMBER
          );


        console.log("");
        console.log("==============================");
        console.log("PAIRING CODE:");
        console.log(code);
        console.log("==============================");
        console.log("");


      } catch(error) {

        console.error(
          "Pairing code failed:",
          error
        );

      }

    }



    // Connection handling

    sock.ev.on(
      "connection.update",
      (update) => {


        const {
          connection,
          lastDisconnect
        } = update;



        console.log(
          "Connection:",
          connection
        );



        if(connection === "open") {

          console.log(
            "✅ MATCH Contact Bot connected!"
          );

          restarting = false;

        }



        if(connection === "close") {


          const statusCode =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;



          const shouldReconnect =
            statusCode !== DisconnectReason.loggedOut;



          console.log(
            "Disconnected. Reconnect:",
            shouldReconnect
          );



          if(
            shouldReconnect &&
            !restarting
          ) {


            restarting = true;


            setTimeout(() => {

              startBot();

            },5000);


          }


        }


      });



    // Contacts storage


    sock.ev.on(
      "contacts.upsert",
      (contacts)=>{

        contacts.forEach(contact=>{

          contactStore[contact.id] =
            contact;

        });

      });



    sock.ev.on(
      "contacts.set",
      ({contacts})=>{

        contacts.forEach(contact=>{

          contactStore[contact.id] =
            contact;

        });

      });



    sock.ev.on(
      "contacts.update",
      (updates)=>{

        updates.forEach(update=>{

          contactStore[update.id] = {

            ...(contactStore[update.id] || {}),

            ...update

          };

        });

      });




    // Export command


    sock.ev.on(
      "messages.upsert",
      async ({messages})=>{


        const msg = messages[0];


        if(!msg?.message)
          return;


        if(!msg.key.fromMe)
          return;



        const text =
          msg.message.conversation ||
          msg.message
          ?.extendedTextMessage
          ?.text ||
          "";



        if(
          text.trim().toLowerCase()
          !== "export"
        )
          return;



        const chat =
          msg.key.remoteJid;



        try {


          await sock.sendMessage(
            chat,
            {
              text:
              "🔍 Scanning your chats..."
            }
          );



          const unsaved =
            findUnsavedNumbers(
              contactStore
            );



          if(!unsaved.length) {


            await sock.sendMessage(
              chat,
              {
                text:
                "No unsaved contacts found."
              }
            );


            return;

          }



          await sock.sendMessage(
            chat,
            {

              document:
                Buffer.from(
                  buildVcf(unsaved),
                  "utf8"
                ),


              fileName:
                "MATCH-contacts.vcf",


              mimetype:
                "text/vcard"

            });



          await sock.sendMessage(
            chat,
            {
              text:
              `✅ Done! Found ${unsaved.length} unsaved contact(s).`
            });



        } catch(error) {


          console.error(
            "Export error:",
            error
          );


          await sock.sendMessage(
            chat,
            {
              text:
              "❌ Export failed. Check Railway logs."
            }
          );


        }


      });



  } catch(error) {


    console.error(
      "Bot startup failed:",
      error
    );


    setTimeout(
      startBot,
      5000
    );


  }


}



startBot();




process.on(
  "unhandledRejection",
  error=>{
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);



process.on(
  "uncaughtException",
  error=>{
    console.error(
      "Uncaught exception:",
      error
    );
  }
);
