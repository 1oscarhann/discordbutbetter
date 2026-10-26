// Second browser suite: saved messages, threads, send later, wiki, friends, guestbook, disappearing DMs, profile songs. SKIP_SLOW=1 skips the 2-minute send-later wait.
// Run against a live instance (default: pnpm dev on :5173):  BASE=http://localhost:5173 node e2e/flows.cjs
// Needs Playwright's Chromium:   pnpm exec playwright install chromium
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:5173';
const OUT = __dirname + '/.shots/flows';
fs.mkdirSync(OUT, { recursive: true });
const problems = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`[${who} pageerror] ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/401|403/.test(m.text()) && problems.push(`[${who} console] ${m.text()}`));
  page.on('response', (r) => r.status() >= 500 && problems.push(`[${who} http ${r.status()}] ${r.url()}`));
};
const step = async (label, fn) => {
  const t = Date.now();
  try {
    await fn();
    console.log(`ok   ${label} (${Date.now() - t}ms)`);
  } catch (e) {
    console.log(`FAIL ${label}: ${e.message.split('\n')[0]}`);
    throw e;
  }
};

async function register(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  watch(page, name);
  await page.goto(BASE + '/register');
  await page.fill('#email', `${name}@example.com`);
  await page.fill('#username', name);
  await page.fill('#pw', 'correct horse battery');
  await page.fill('#pw2', 'correct horse battery');
  await page.click('button:has-text("Create account")');
  await page.waitForSelector('[title="Create a server"]', { timeout: 15000 });
  return { ctx, page };
}

/** A short tone as a 16-bit mono WAV, so the test needs no audio tools. */
function sineWav(freq, seconds, rate = 22050) {
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), 44 + i * 2);
  return buf;
}

const localInput = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

(async () => {
  const browser = await chromium.launch();
  let A, B;
  try {
    let invite;
    await step('setup: kim makes a server, lee joins', async () => {
      A = await register(browser, 'kim');
      B = await register(browser, 'lee');
      const a = A.page;
      await a.click('[title="Create a server"]');
      await a.fill('#gn', 'Flows');
      await a.click('button:has-text("Create")');
      await a.waitForSelector('textarea');
      await a.click('[title="Invite"] >> nth=0', { force: true });
      await a.waitForFunction(() => document.querySelector('#iurl')?.value?.includes('/invite/'));
      invite = await a.inputValue('#iurl');
      await a.keyboard.press('Escape');
      await B.page.goto(invite.replace(/^https?:\/\/[^/]+/, BASE));
      await B.page.click('button:has-text("Accept invite")');
      await B.page.waitForSelector('textarea');
    });

    await step('save a message, find it in Saved messages', async () => {
      const a = A.page;
      await a.fill('textarea', 'remember this one');
      await a.keyboard.press('Enter');
      const msg = a.locator('article.msg:has-text("remember this one")');
      await msg.waitFor();
      await msg.hover();
      await msg.locator('button[title="More"]').click();
      await a.click('.menu-item:has-text("Save message")');
      await a.waitForSelector('text=Saved', { timeout: 5000 });
      await a.goto(BASE + '/app/me/saved');
      await a.waitForSelector(':text("remember this one")', { timeout: 10000 });
    });

    await step('start a thread from a message; the other person replies in it', async () => {
      const a = A.page, b = B.page;
      await a.goBack();
      await a.waitForSelector('textarea');
      await a.fill('textarea', 'thread starter here');
      await a.keyboard.press('Enter');
      const msg = a.locator('article.msg:has-text("thread starter here")');
      await msg.waitFor();
      await msg.hover();
      await msg.locator('button[title="Create thread"]').click();
      // thread pane opens with its own composer
      const pane = a.locator('.thread-pane, aside:has(textarea)').last();
      await pane.locator('textarea').waitFor({ timeout: 5000 });
      await pane.locator('textarea').fill('first reply in the thread');
      await pane.locator('textarea').press('Enter');
      await pane.locator(':text("first reply in the thread")').waitFor({ timeout: 5000 });
      await a.screenshot({ path: `${OUT}/01-thread.png` });
      // lee sees the thread created system message and can open it
      // threads started from a message show up as a chip under it
      await b.locator('article.msg:has-text("thread starter here") button.threadlink').click({ timeout: 10000 });
      const bp = b.locator('.thread-pane, aside:has(textarea)').last();
      await bp.locator(':text("first reply in the thread")').waitFor({ timeout: 10000 });
      await bp.locator('textarea').fill('lee was here');
      await bp.locator('textarea').press('Enter');
      await a.waitForSelector(':text("lee was here")', { timeout: 10000 });
    });

    if (!process.env.SKIP_SLOW) await step('send later: schedule a message 1 minute out, it shows in Scheduled, then arrives', async () => {
      const a = A.page, b = B.page;
      await a.keyboard.press('Escape');
      await a.locator('main textarea, .chat textarea').first().fill('hello from the past');
      await a.locator('button[title="Send later"]').first().click();
      await a.click('.menu-item:has-text("Send later")');
      await a.waitForSelector('#when');
      const when = new Date(Date.now() + 120_000);
      await a.fill('#when', localInput(when));
      await a.click('button:has-text("Schedule")');
      await a.waitForTimeout(500);
      const url = a.url();
      await a.goto(BASE + '/app/me/scheduled');
      await a.waitForSelector(':text("hello from the past")', { timeout: 10000 });
      await a.screenshot({ path: `${OUT}/02-scheduled.png` });
      await a.goto(url);
      await b.waitForSelector('article.msg:has-text("hello from the past")', { timeout: 200000 });
      const clock = await b.locator('article.msg:has-text("hello from the past") [title="Sent with send later"]').count();
      if (!clock) throw new Error('missing "sent with send later" marker');
    });

    await step('wiki channel: create a page, other member reads it', async () => {
      const a = A.page, b = B.page;
      await a.click('[title="Create channel"] >> nth=0', { force: true });
      await a.click('label.type:has-text("Wiki")');
      await a.fill('#cn', 'handbook');
      await a.click('button:has-text("Create")');
      await a.waitForSelector('button:has-text("New page")', { timeout: 10000 });
      await a.click('button:has-text("New page")');
      await a.fill('input[placeholder="Page title"]', 'House rules');
      await a.fill('textarea.body-in', '# Rules\n\n1. **be nice**\n2. no spoilers');
      await a.click('button:has-text("Save")');
      await a.waitForSelector('h1:has-text("Rules"), .md h1', { timeout: 10000 });
      await b.click('text="handbook"');
      await b.click('button.pg:has-text("House rules")', { timeout: 10000 });
      await b.waitForSelector(':text("be nice")', { timeout: 10000 });
      await b.screenshot({ path: `${OUT}/03-wiki.png` });
    });

    let dmUrl;
    await step('friends: lee sends a request, kim accepts', async () => {
      const a = A.page, b = B.page;
      await b.goto(BASE + '/app/me');
      await b.click('button.t.add');
      await b.fill('input[placeholder="username"]', 'kim');
      await b.click('button:has-text("Send request")');
      await b.waitForSelector('.ok', { timeout: 5000 });
      await a.goto(BASE + '/app/me');
      await a.click('button.t:has-text("Pending")');
      await a.click('[title="Accept"]', { timeout: 10000 });
      await a.click('button.t:has-text("All")');
      await a.waitForFunction(() => /ALL — 1[\s\S]*\blee\b/.test(document.body.innerText), null, { timeout: 5000 });
    });

    await step('guestbook: lee (a friend now) signs kim\'s guestbook', async () => {
      const b = B.page;
      await b.goto(BASE + '/app/me');
      await b.click('button.t:has-text("All")');
      await b.locator('button:has(.un:text-is("@kim"))').first().click();
      await b.waitForSelector('button:has-text("Guestbook")', { timeout: 10000 });
      await b.click('button:has-text("Guestbook")');
      await b.fill('input[placeholder="Leave a note (public)"]', 'kim is cool');
      await b.click('button.pbtn:has-text("Sign")');
      await b.waitForSelector(':text("kim is cool")', { timeout: 5000 });
      await b.keyboard.press('Escape');
    });

    await step('disappearing DMs: kim turns on a 5 minute timer, lee is told, new messages get an expiry', async () => {
      const a = A.page, b = B.page;
      await a.goto(BASE + '/app/me');
      await a.click('button.t:has-text("All")');
      await a.locator('[title="Message"]').first().click();
      await a.waitForURL(/\/app\/me\/\d+/, { timeout: 10000 });
      dmUrl = a.url();
      await a.click('[title="Channel settings"]');
      await a.selectOption('#dis', '300');
      await a.keyboard.press('Escape');
      await a.waitForSelector(':text("turned on disappearing messages")', { timeout: 10000 });
      await a.locator('main textarea, .chat textarea').first().fill('this will vanish');
      await a.keyboard.press('Enter');
      await b.goto(dmUrl.replace(/^https?:\/\/[^/]+/, BASE));
      await b.waitForSelector(':text("turned on disappearing messages")', { timeout: 10000 });
      const m = b.locator('article.msg:has-text("this will vanish")');
      await m.waitFor({ timeout: 10000 });
      if (!(await m.locator('[title^="Disappears"]').count())) throw new Error('no expiry marker on the message');
      await b.screenshot({ path: `${OUT}/04-disappearing.png` });
    });

    await step('profile song: kim uploads a clip, lee sees the player (not autoplaying)', async () => {
      const a = A.page, b = B.page;
      const wav = OUT + '/song.wav';
      fs.writeFileSync(wav, sineWav(440, 3));
      await a.keyboard.press('Control+,');
      await a.click('.side button:has-text("Profile")');
      await a.waitForSelector('#dn');
      const [chooser] = await Promise.all([a.waitForEvent('filechooser'), a.click('button:has-text("Upload a clip")')]);
      await chooser.setFiles(wav);
      await a.waitForSelector('#st', { timeout: 15000 });
      await a.fill('#st', 'my theme song');
      await a.click('button:has-text("Save changes")');
      await a.waitForSelector('text=Profile saved', { timeout: 10000 });
      await a.keyboard.press('Escape');
      await b.goto(dmUrl.replace(/^https?:\/\/[^/]+/, BASE));
      await b.locator('article.msg .author:has-text("kim")').first().click();
      await b.waitForSelector(':text("my theme song")', { timeout: 10000 });
      const label = await b.locator('.song .pbtn').getAttribute('aria-label');
      if (label !== 'Play profile song') throw new Error(`song should be paused for visitors, button says "${label}"`);
      await b.screenshot({ path: `${OUT}/05-song.png` });
    });
  } catch (e) {
    for (const [i, c] of browser.contexts().entries()) await c.pages()[0]?.screenshot({ path: `${OUT}/zz-${i}.png` }).catch(() => {});
  } finally {
    console.log(`\n--- problems (${problems.length}) ---\n` + [...new Set(problems)].slice(0, 30).join('\n'));
    await browser.close();
  }
})();
