// Sutra Token Mining: Telegram bot
// Environment variables (set them on your host, never write the token in this file):
//   BOT_TOKEN   token from @BotFather
//   WEBAPP_URL  public https link of your mining app (the page that serves index.html)
const http = require('http');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const BOT_USERNAME = 'SutraToken_bot';
const GROUP_LINK = 'https://t.me/SutraTokenOfficialgroup';
const SUPPORT_LINK = 'https://t.me/SutraTokenMiningOfficial';

const missing = ['BOT_TOKEN', 'WEBAPP_URL'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing environment variable(s): ' + missing.join(', ') + '. Add them in your host settings (Render → Environment) and redeploy.');
  process.exit(1);
}
try {
  if (new URL(WEBAPP_URL).protocol !== 'https:') throw new Error('not https');
} catch (e) {
  console.error('❌ WEBAPP_URL must be a full https link, for example https://your-app.onrender.com');
  process.exit(1);
}

const WELCOME = `⛏️ <b>Welcome to Sutra Token Mining!</b>

🔹 <b>24-hour mining, 100% free:</b> earn 2,000 $SUTRA every session
🔹 <b>Free boosters 2x → 3x → 4x:</b> up to +2,000 extra per 4-hour boost, 2 boosts a day
🔹 <b>Daily rewards:</b> a 30-day gift calendar (Day 1 = 50 up to Day 30 = 1,500) + daily check-in
🔹 <b>Daily challenges:</b> 3 new challenges every day
🔹 <b>Tap &amp; earn:</b> 500 Fuel every day, with Fuel 2x and combos
🔹 <b>Refer &amp; earn:</b> 500 $SUTRA for every friend who starts mining, plus 20 referral levels, badges and milestone bonuses
🔹 <b>Social claims:</b> join our community and claim 100 $SUTRA per task, once
🔹 <b>Fast support:</b> our Telegram support group
🔹 <b>SST coin:</b> planned conversion, 1,000 $SUTRA = 1 SST
🔹 <b>Withdrawal:</b> coming soon

📢 <a href="${GROUP_LINK}">Official Telegram group</a>
💬 <a href="${SUPPORT_LINK}">Official support</a>
📱 App: coming soon on Play Store

🛠 If you face any issue, we will try our best to fix it. Please be patient.

⚠️ <b>Warning:</b> this is a long-term, high-risk project. No guaranteed value, listing, withdrawal date or profit. Never quit your job, business or studies for it, and never put in money you cannot afford to lose.

Tap below to start mining! 🚀`;

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  // A friend who came through a referral link (…?start=ref_123) is passed on to the app as ?ref=ref_123
  const payload = (ctx.startPayload || '').trim();
  const url = new URL(WEBAPP_URL);
  if (/^ref_\d{1,20}$/.test(payload)) url.searchParams.set('ref', payload);
  const open = Markup.button.webApp('⛏️ Open Sutra Mining', url.toString());
  await ctx.replyWithHTML(WELCOME, {
    link_preview_options: { is_disabled: true },
    ...Markup.inlineKeyboard([
      [open],
      [Markup.button.url('📢 Telegram Group', GROUP_LINK)],
      [Markup.button.url('💬 Telegram Support', SUPPORT_LINK), Markup.button.callback('📱 App Coming Soon', 'soon')]
    ])
  });
});

bot.action('soon', (ctx) => ctx.answerCbQuery('The Play Store app is coming soon 📱', { show_alert: true }));
bot.catch((err) => console.error('Bot error:', err));

// tiny health-check server so hosts that expect an open port (for example Render web services) keep the bot running
http.createServer((_, res) => { res.writeHead(200); res.end('ok'); }).listen(process.env.PORT || 3000);

process.on('unhandledRejection', (e) => console.error('Unhandled error:', e));
(async () => {
  try {
    const me = await bot.telegram.getMe();
    console.log('✅ Token accepted: @' + me.username);
  } catch (e) {
    console.error('❌ Telegram rejected BOT_TOKEN. Copy the token again from @BotFather (no spaces, no quotes), or create a new one with /revoke.');
    process.exit(1);
  }
  bot.launch().catch((err) => {
    const m = String((err && err.message) || err);
    if (/409/.test(m)) console.error('❌ Another copy of this bot is already running (409 Conflict). Stop the old bot or old deploy, then restart this one.');
    else console.error('❌ Bot failed to start:', m);
    process.exit(1);
  });
  console.log('✅ Sutra Token bot is running');
})();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
