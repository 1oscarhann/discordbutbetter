// Two fake-microphone users join a voice channel and must receive each other's audio. Needs LiveKit (e.g. the compose stack).
// Run against a live instance:  BASE=https://localhost node e2e/voice.cjs
// Needs Playwright's Chromium:   pnpm exec playwright install chromium
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'https://localhost';
const OUT = __dirname + '/.shots/voice';
require('fs').mkdirSync(OUT, { recursive: true });
const problems = [];
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'] });
  const mk = async (name) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1300, height: 850 }, permissions: ['microphone', 'camera'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`[${name}] ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && problems.push(`[${name} console] ${m.text()}`));
    await page.goto(BASE + '/register');
    await page.fill('#email', `${name}@example.com`);
    await page.fill('#username', name);
    await page.fill('#pw', 'correct horse battery');
    await page.fill('#pw2', 'correct horse battery');
    await page.click('button:has-text("Create account")');
    await page.waitForSelector('[title="Create a server"]', { timeout: 15000 });
    return page;
  };
  try {
    const a = await mk('vera');
    await a.click('[title="Create a server"]');
    await a.fill('#gn', 'Voice Test');
    await a.click('button:has-text("Create")');
    await a.waitForSelector('textarea');
    await a.click('[title="Invite"] >> nth=0', { force: true });
    await a.waitForFunction(() => document.querySelector('#iurl')?.value?.includes('/invite/'));
    const invite = await a.inputValue('#iurl');
    await a.keyboard.press('Escape');
    const b = await mk('wade');
    await b.goto(invite);
    await b.click('button:has-text("Accept invite")');
    await b.waitForSelector('textarea');
    for (const p of [a, b]) {
      await p.click('text="General"');
      await p.waitForSelector('text=Voice connected', { timeout: 20000 });
    }
    console.log('ok   both users show "Voice connected"');
    // each should see the other's audio arrive (LiveKit subscribed track → <audio> element)
    const remoteAudio = async (p) =>
      p.waitForFunction(() => [...document.querySelectorAll('audio')].some((el) => el.srcObject && el.srcObject.getAudioTracks().length > 0), null, { timeout: 20000 });
    await remoteAudio(a);
    await remoteAudio(b);
    console.log('ok   both receive the other\'s audio track over WebRTC');
    await a.waitForTimeout(1500);
    await a.screenshot({ path: OUT + '/voice.png' });
    // server-side voice state came back via the LiveKit webhook / gateway
    const count = await a.locator('text=wade').count();
    console.log('ok   voice view rendered (wade visible ' + count + 'x)');
  } catch (e) {
    console.log('FAIL', e.message.split('\n')[0]);
    for (const [i, p] of browser.contexts().entries()) await p.pages()[0]?.screenshot({ path: OUT + '/zz-voice-' + i + '.png' }).catch(() => {});
  } finally {
    console.log('problems:', problems.length ? problems.slice(0, 15).join('\n') : 'none');
    await browser.close();
  }
})();
