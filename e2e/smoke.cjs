// Main browser smoke test: two users, the core chat flows.
// Run against a live instance (default: pnpm dev on :5173):  BASE=http://localhost:5173 node e2e/smoke.cjs
// Needs Playwright's Chromium:   pnpm exec playwright install chromium
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173';
const OUT = __dirname + '/.shots/smoke';
require('fs').mkdirSync(OUT, { recursive: true });

const problems = [];
function watch(page, who) {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${who} console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${who} pageerror] ${e.message}\n${e.stack?.split('\n').slice(0, 4).join('\n')}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('/favicon')) problems.push(`[${who} http ${r.status()}] ${r.request().method()} ${r.url()}`);
  });
}

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
  await page.waitForURL('**/app**', { timeout: 15000 });
  await page.waitForSelector('[title="Create a server"]', { timeout: 15000 });
  return { ctx, page };
}

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

(async () => {
  const browser = await chromium.launch();
  let alice, bob;
  try {
    await step('alice registers', async () => {
      alice = await register(browser, 'alice');
      await alice.page.screenshot({ path: `${OUT}/01-alice-home.png` });
    });

    await step('alice creates a server', async () => {
      const p = alice.page;
      await p.click('[title="Create a server"]');
      await p.fill('#gn', 'Test Server');
      await p.click('button:has-text("Create")');
      await p.waitForURL(/\/app\/\d+\/\d+/, { timeout: 10000 });
      await p.waitForSelector('textarea', { timeout: 10000 });
    });

    await step('alice sends a markdown message', async () => {
      const p = alice.page;
      await p.fill('textarea', 'hello **world** — `code` and a link https://example.com');
      await p.keyboard.press('Enter');
      await p.waitForSelector('article.msg :text("world")', { timeout: 10000 });
      await p.screenshot({ path: `${OUT}/02-alice-chat.png` });
    });

    let inviteUrl = '';
    await step('alice makes an invite', async () => {
      const p = alice.page;
      await p.click('[title="Invite"] >> nth=0', { force: true });
      await p.waitForFunction(() => document.querySelector('#iurl')?.value?.includes('/invite/'), null, { timeout: 10000 });
      inviteUrl = await p.inputValue('#iurl');
      await p.keyboard.press('Escape');
    });

    await step('bob registers and joins via invite', async () => {
      bob = await register(browser, 'bob');
      const p = bob.page;
      await p.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, BASE));
      await p.click('button:has-text("Accept invite")', { timeout: 10000 });
      await p.waitForURL(/\/app\/\d+/, { timeout: 10000 });
      await p.waitForSelector('article.msg :text("world")', { timeout: 10000 });
    });

    await step('bob mentions alice, alice sees it live', async () => {
      await bob.page.fill('textarea', '@alice yo, ||spoiler|| here');
      await bob.page.keyboard.press('Escape'); // close autocomplete if open
      await bob.page.keyboard.press('Enter');
      await alice.page.waitForSelector('article.msg :text("yo,")', { timeout: 10000 });
      await alice.page.screenshot({ path: `${OUT}/03-alice-sees-bob.png` });
    });

    await step('alice edits her message and the edit shows for bob', async () => {
      const p = alice.page;
      await p.click('textarea');
      await p.keyboard.press('ArrowUp');
      await p.waitForSelector('text=Editing message', { timeout: 5000 });
      await p.fill('textarea', 'hello **edited world**');
      await p.keyboard.press('Enter');
      await p.waitForSelector('article.msg :text("(edited)"), article.msg .edited', { timeout: 10000 }).catch(() => {});
      await bob.page.waitForSelector('article.msg :text("edited world")', { timeout: 10000 });
    });

    await step('alice opens user settings → profile, edits and saves', async () => {
      const p = alice.page;
      await p.click('[title="Settings"]');
      await p.click('.side button:has-text("Profile")');
      await p.waitForSelector('#dn', { timeout: 10000 });
      await p.fill('#dn', 'Alice ✨');
      await p.fill('#pn', 'she/her');
      await p.fill('#bio', 'I **love** testing');
      await p.click('button:has-text("Add widget")');
      await p.click('.addmenu button:has-text("Currently into")');
      await p.fill('input[placeholder^="Ramen"]', 'Celeste');
      await p.click('.wcard button:has-text("Add")');
      await p.screenshot({ path: `${OUT}/04-profile-editor.png`, fullPage: false });
      await p.click('button:has-text("Save changes")');
      await p.waitForSelector('text=Profile saved', { timeout: 10000 });
    });

    await step('alice tries appearance → light mode and back', async () => {
      const p = alice.page;
      await p.click('.side button:has-text("Appearance")');
      await p.click('.mode:has-text("Daylight")');
      await p.waitForTimeout(400);
      await p.screenshot({ path: `${OUT}/05-light.png` });
      await p.click('.mode:has-text("Midnight")');
      await p.keyboard.press('Escape');
    });

    await step('alice opens server settings → creates a role', async () => {
      const p = alice.page;
      await p.click('.ghead, header button:has-text("Test Server")', { timeout: 5000 }).catch(async () => {
        await p.click('text=Test Server');
      });
      await p.click('button.menu-item:has-text("Server settings")');
      await p.click('.side button:has-text("Roles")');
      await p.click('button:has-text("Create role")');
      await p.waitForSelector('#rn', { timeout: 5000 });
      await p.fill('#rn', 'Mods');
      await p.click('.savebar button:has-text("Save")');
      await p.waitForSelector('.role:has-text("Mods")', { timeout: 5000 });
      await p.screenshot({ path: `${OUT}/06-roles.png` });
      await p.click('.side button:has-text("Audit log")');
      await p.waitForSelector('.entry', { timeout: 5000 });
      await p.screenshot({ path: `${OUT}/07-audit.png` });
      await p.keyboard.press('Escape');
    });

    await step('bob opens alice profile card and sees the new profile', async () => {
      const p = bob.page;
      await p.reload();
      await p.waitForSelector('article.msg', { timeout: 10000 });
      await p.click('article.msg .author:has-text("Alice")', { timeout: 10000 });
      await p.waitForSelector('text=she/her', { timeout: 10000 });
      await p.waitForSelector('text=Celeste', { timeout: 10000 });
      await p.waitForTimeout(400);
      await p.screenshot({ path: `${OUT}/08-bob-sees-profile.png` });
      await p.keyboard.press('Escape');
    });

    await step('quick switcher (Ctrl+K)', async () => {
      const p = alice.page;
      await p.keyboard.press('Control+k');
      await p.waitForSelector('input[aria-label="Search"]', { timeout: 5000 });
      await p.keyboard.type('gen');
      await p.keyboard.press('Enter');
      await p.waitForTimeout(300);
    });

    await step('alice DMs bob and starts tic-tac-toe', async () => {
      const p = alice.page;
      await p.click('article.msg .author:has-text("bob")');
      await p.fill('.profile-card input, input[placeholder^="Message @"]', 'hey bob', { timeout: 5000 }).catch(() => {});
      await p.keyboard.press('Enter');
      await p.waitForURL(/\/app\/me\/\d+/, { timeout: 10000 });
      await p.click('[title="Play a game"]');
      await p.click('button:has-text("Tic-tac-toe")');
      await p.waitForSelector('.gamewrap', { timeout: 10000 });
      await bob.page.goto(p.url().replace(/^https?:\/\/[^/]+/, BASE));
      await bob.page.waitForSelector('.gamewrap', { timeout: 10000 });
      await p.screenshot({ path: `${OUT}/09-dm-game.png` });
    });

    await step('bob joins the game and they play to a win', async () => {
      const a = alice.page, b = bob.page;
      await b.click('.gamewrap button:has-text("Join")');
      // alice (X) takes the top row, bob plays the middle row
      const cell = (p, i) => p.locator('.gamewrap button.cell').nth(i);
      const playX = async (i) => { await cell(a, i).waitFor(); await a.waitForFunction((i) => !document.querySelectorAll('.gamewrap button.cell')[i]?.disabled, i, { timeout: 5000 }); await cell(a, i).click(); };
      const playO = async (i) => { await b.waitForFunction((i) => !document.querySelectorAll('.gamewrap button.cell')[i]?.disabled, i, { timeout: 5000 }); await cell(b, i).click(); };
      await playX(0); await playO(3); await playX(1); await playO(4); await playX(2);
      await a.waitForSelector('.gamewrap button.cell.win', { timeout: 5000 });
      await b.waitForSelector('.gamewrap button.cell.win', { timeout: 5000 });
      await b.screenshot({ path: `${OUT}/10-game-won.png` });
    });

    await step('reactions sync between users', async () => {
      const a = alice.page, b = bob.page;
      await a.locator('article.msg:has-text("hey bob")').hover();
      await a.click('article.msg:has-text("hey bob") button[title="React 👍"]');
      await b.waitForSelector('article.msg:has-text("hey bob") .reactions :text("1")', { timeout: 10000 });
    });

    await step('image upload with EXIF gets stripped and shows for the other side', async () => {
      const a = alice.page, b = bob.page;
      // a tiny JPEG with an EXIF GPS block, written by sharp so it's a real image
      const sharp = require('node:module').createRequire(require.resolve('../apps/server/package.json'))('sharp');
      const buf = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ff6a88' } })
        .withExif({ IFD0: { Artist: 'secret-name', Copyright: 'secret' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } })
        .jpeg()
        .toBuffer();
      if (!buf.includes(Buffer.from('secret-name'))) throw new Error('test image has no EXIF to begin with');
      await a.setInputFiles('input[type=file][multiple]', { name: 'pic.jpg', mimeType: 'image/jpeg', buffer: buf });
      await a.fill('textarea', 'look at this');
      await a.keyboard.press('Enter');
      const img = b.locator('article.msg:has-text("look at this") img').first();
      await img.waitFor({ timeout: 15000 });
      const src = await img.getAttribute('src');
      const res = await b.request.get(BASE + src);
      const body = await res.body();
      if (res.status() !== 200) throw new Error('image fetch ' + res.status());
      if (body.includes(Buffer.from('secret-name'))) throw new Error('EXIF was NOT stripped');
      const h = res.headers();
      if (h['x-content-type-options'] !== 'nosniff') throw new Error('missing nosniff on files');
      await b.screenshot({ path: `${OUT}/11-image.png` });
    });

    await step('search finds the edited message', async () => {
      const a = alice.page;
      await a.goto(BASE + '/app');
      await a.click('.item[title="Test Server"], [title="Test Server"]');
      await a.waitForSelector('textarea');
      await a.fill('input[aria-label="Search messages"]', 'edited');
      await a.keyboard.press('Enter');
      await a.waitForSelector('aside :text("edited world"), .panel :text("edited world")', { timeout: 10000 });
      await a.screenshot({ path: `${OUT}/12-search.png` });
    });

    await step('compact mode', async () => {
      const a = alice.page;
      await a.keyboard.press('Control+,');
      await a.click('.side button:has-text("Appearance")');
      await a.click('label.srow:has-text("Compact messages") input');
      await a.keyboard.press('Escape');
      await a.waitForTimeout(300);
      await a.screenshot({ path: `${OUT}/13-compact.png` });
    });


    await step('instance admin panel: alice (first account) can use it, bob cannot see it', async () => {
      const a = alice.page, b = bob.page;
      await a.keyboard.press('Control+,');
      await a.click('.side button:has-text("Instance admin")');
      await a.waitForSelector('.stat:has-text("accounts")', { timeout: 5000 });
      await a.click('.tabs button:has-text("Users")');
      await a.waitForSelector('.list-item:has-text("@bob")', { timeout: 5000 });
      await a.click('.list-item:has-text("@bob") button:has-text("Reset link")');
      await a.waitForFunction(() => [...document.querySelectorAll('input[readonly]')].some((i) => i.value.includes('/reset?token=')), null, { timeout: 5000 });
      await a.screenshot({ path: `${OUT}/16-admin.png` });
      await a.keyboard.press('Escape');
      await a.click('.tabs button:has-text("Sign-up links")');
      await a.click('button:has-text("Create & copy link")');
      await a.waitForSelector('.list-item code', { timeout: 5000 });
      await a.keyboard.press('Escape');
      await b.keyboard.press('Control+,');
      await b.waitForSelector('.side button:has-text("My account")');
      if (await b.locator('.side button:has-text("Instance admin")').count()) throw new Error('non-admin sees the admin tab');
      await b.keyboard.press('Escape');
    });

    await step('phone-width layout', async () => {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, storageState: await bob.ctx.storageState() });
      const p = await ctx.newPage();
      watch(p, 'bob-mobile');
      await p.goto(BASE + '/app');
      await p.waitForSelector('[title="Create a server"], .burger', { timeout: 10000 });
      await p.screenshot({ path: `${OUT}/14-mobile-home.png` });
      // on phones the server list lives behind the hamburger menu
      await p.click('.burger');
      await p.click('[title="Test Server"]', { timeout: 5000 });
      await p.waitForSelector('textarea', { timeout: 10000 });
      await p.waitForTimeout(300);
      await p.screenshot({ path: `${OUT}/15-mobile-guild.png` });
      await ctx.close();
    });
  } catch (e) {
    console.log(e.stack?.split('\n').slice(0, 3).join('\n'));
    if (alice) await alice.page.screenshot({ path: `${OUT}/zz-alice-fail.png` }).catch(() => {});
    if (bob) await bob.page.screenshot({ path: `${OUT}/zz-bob-fail.png` }).catch(() => {});
  } finally {
    console.log('\n--- problems seen (' + problems.length + ') ---');
    for (const p of [...new Set(problems)].slice(0, 60)) console.log(p);
    await browser.close();
  }
})();
