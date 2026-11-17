// Render CF-protected catalogue pages with a real browser and store the HTML for cue to read.
//
// Budget rules (never hog GitHub Actions):
//  • only entries that are MISSING or older than FRESH_MIN are rendered, oldest first, MAX_PAGES per run
//  • a run stops early once it has produced MAX_PAGES fresh pages
//  • mirror files are pruned to MAX_FILES per site, so the repo cannot grow without bound
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { chromium: playwrightChromium } = require('playwright');
let chromium = playwrightChromium;
try { // stealth patching (webdriver flag, chrome runtime, plugins) — Cloudflare checks these first
  const { addExtra } = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  chromium = addExtra(playwrightChromium); chromium.use(stealth);
} catch (e) { console.log('stealth plugin unavailable, plain chromium'); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FRESH_MIN = Number(process.env.FRESH_MIN || 45);
const MAX_PAGES = Number(process.env.MAX_PAGES || 6);
const MAX_FILES = Number(process.env.MAX_FILES || 300);
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

const CHALLENGE = /just a moment|attention required|checking your browser|لحظة|تحقق/i;
async function solve(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 40; i++) {
    // a visible Turnstile checkbox sometimes has to be clicked before it clears itself
    for (const frame of page.frames()) {
      if (!/challenges\.cloudflare\.com/.test(frame.url())) continue;
      try {
        const box = frame.locator('input[type=checkbox], .mark, #challenge-stage');
        if (await box.count()) { await box.first().click({ timeout: 1500 }).catch(() => {}); }
      } catch (e) {}
    }
    const html = await page.content();
    if (!CHALLENGE.test(await page.title()) && /\/video\.php|\/watch\/|\/series\/|\/movie\/|\/film\//.test(html)) return;
    await page.waitForTimeout(1500);
  }
}

function work() {
  const { sites } = JSON.parse(fs.readFileSync('sites.json', 'utf8'));
  const jobs = [];
  for (const site of sites) {
    for (const q of site.queries) {
      const url = site.root + site.search + encodeURIComponent(q);
      const file = path.join('mirror', site.id, sha(url) + '.json');
      let at = 0, links = 0;
      try { const prev = JSON.parse(fs.readFileSync(file, 'utf8')); at = prev.at || 0; links = prev.links || 0; } catch (e) {}
      // a page that produced no links last time is retried immediately, not after the fresh window
      if (links > 0 && Date.now() - at < FRESH_MIN * 60000) continue;
      jobs.push({ site, q, url, file, at });
    }
  }
  return jobs.sort((a, b) => a.at - b.at).slice(0, MAX_PAGES);
}

/** Per-site index: requested path → mirror file, so the worker can map a live URL to a mirrored file. */
function index(id) {
  const file = path.join('mirror', id, 'index.json');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  return new Proxy(map, { set(t, k, v) { t[k] = v; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(t)); return true; } });
}

function prune() {
  for (const id of fs.existsSync('mirror') ? fs.readdirSync('mirror') : []) {
    const dir = path.join('mirror', id);
    const files = fs.readdirSync(dir).filter(f => f !== 'index.json').map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(MAX_FILES);
    for (const { f } of files) fs.unlinkSync(path.join(dir, f));
  }
}

(async () => {
  const jobs = work();
  if (!jobs.length) { console.log('queue fresh — nothing to do'); return; }
  console.log('rendering ' + jobs.length + ' page(s)');
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'ar-EG', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  let ok = 0;
  for (const job of jobs) {
    try {
      await solve(page, job.site.root + '/');
      await solve(page, job.url);
      await page.waitForTimeout(1200);
      const html = await page.content();
      const links = (html.match(/\/video\.php|\/watch\/|\/series\/|\/movie\/|\/film\//g) || []).length;
      fs.mkdirSync(path.dirname(job.file), { recursive: true });
      const entry = { site: job.site.id, url: job.url, at: Date.now(), title: await page.title(), links, html };
      fs.writeFileSync(job.file, JSON.stringify(entry));
      index(job.site.id)[new URL(job.url).pathname + new URL(job.url).search] = { f: path.basename(job.file), at: entry.at, links, title: entry.title };
      console.log(`${job.site.id} ${job.q} links=${links} bytes=${html.length} final=${page.url()} title=${await page.title()}`);
      if (links) ok++;
    } catch (e) { console.log(`${job.site.id} ${job.q} FAILED ${e.message.slice(0, 80)}`); }
  }
  await browser.close();
  prune();
  if (!ok) console.error('no page produced links (details above)');
})().catch(e => { console.error(e); process.exit(1); });
