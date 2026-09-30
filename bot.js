// =====================================================================
//  Sutra Token - Telegram bot (the message + buttons shown on /start)
//  Uses "telegraf" (a newer, actively maintained library) instead of the
//  older node-telegram-bot-api, to avoid its outdated-dependency warnings.
//  This is a SEPARATE, standalone program. It does NOT touch, load, or
//  serve your Mining App files (index.html / app.js) in any way.
// =====================================================================

const http = require('http');
const { Telegraf } = require('telegraf');

// ---- EDIT THESE --------------------------------------------------------
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || "";           // from @BotFather (set the real value in Render -> Environment)
const BOT_USERNAME   = "SutraToken_bot";                               // your bot username, no @
const APP_SHORT_NAME = "";                                             // optional: Mini App short name from BotFather /newapp. Leave "" if you use "Menu Button" instead
const GROUP_LINK     = "https://t.me/SutraTokenOfficialgroup";         // your official Telegram group
const SUPPORT_LINK   = "https://t.me/SutraTokenMiningOfficial";        // your official support chat
// -------------------------------------------------------------------------

if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Set it in Render -> Environment.");
  process.exit(1);
}

// The link that opens the Mining App directly (carries a referral code when someone was invited)
const appLink = (ref) => {
  const start = ref ? `ref_${ref}` : "app";
  return APP_SHORT_NAME
    ? `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=${start}`
    : `https://t.me/${BOT_USERNAME}?startapp=${start}`;
};

const WELCOME_TEXT =
`⛏️ *Welcome to Sutra Token Mining\\!*

🔹 24\\-Hour Mining — Earn 2,000 \\$SUTRA per session
🔹 Boosts — 2x → 3x → 4x for 4 hours \\(up to \\+2,000 extra\\)
🔹 Daily Gift Rewards — Claim free tokens every day
🔹 Video Claim Rewards — Watch & earn bonus \\$SUTRA
🔹 Refer & Earn — Invite friends, get reward tokens
🔹 Withdrawal — Coming Soon

🚀 Limited token supply\\. Mine early, earn more\\!

Tap below to start mining\\!`;

const bot = new Telegraf(BOT_TOKEN);

function welcomeKeyboard(ref) {
  return {
    inline_keyboard: [
      [{ text: "⛏️ Sutra Mining Open", url: appLink(ref) }],
      [{ text: "📢 Telegram Group", url: GROUP_LINK }],
      [
        { text: "💬 Telegram Support", url: SUPPORT_LINK },
        { text: "📱 App Coming Soon", callback_data: "app_soon" }
      ]
    ]
  };
}

// /start  and  /start ref_XXXXXXXX  (from a shared referral link)
bot.start((ctx) => {
  const param = (ctx.startPayload || "").trim();      // telegraf auto-parses the text after /start
  const ref = param.startsWith("ref_") ? param.slice(4) : "";
  ctx.reply(WELCOME_TEXT, {
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
    reply_markup: welcomeKeyboard(ref)
  }).catch(e => console.error("reply failed:", e.message));
});

// "App Coming Soon" button - just shows a small popup, doesn't open anything (app isn't live yet)
bot.action('app_soon', (ctx) => {
  ctx.answerCbQuery("📱 The Sutra Token app is coming soon on the Play Store!", { show_alert: true })
    .catch(e => console.error("answerCbQuery failed:", e.message));
});

bot.catch((err) => console.error("Bot error:", err.message));

bot.launch().then(() => console.log("Sutra Token bot started (long polling)..."));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ---- tiny web server so Render's health check sees the service as "up" ----
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('Sutra Token bot is running.'); })
    .listen(PORT, () => console.log(`Health check server listening on ${PORT}`));
