// Render CF-protected catalogue pages with a real browser and store the HTML for cue to read.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { chromium } = require('playwright');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

async function solve(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 25; i++) {
    const title = await page.title();
    if (!/just a moment|attention required|checking your browser/i.test(title)) return page;
    await page.waitForTimeout(1500);
  }
  return page;
}

(async () => {
  const { sites } = JSON.parse(fs.readFileSync('sites.json', 'utf8'));
  const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'ar-EG', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const out = [];
  for (const site of sites) {
    await solve(page, site.root + '/');
    for (const q of site.queries) {
      const url = site.root + site.search + encodeURIComponent(q);
      await solve(page, url);
      await page.waitForTimeout(1200);
      const html = await page.content();
      const links = (html.match(/\/video\.php|\/watch\/|\/series\/|\/movie\//g) || []).length;
      const rec = { site: site.id, url, at: Date.now(), title: await page.title(), links, html };
      const dir = path.join('mirror', site.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, sha(url) + '.json'), JSON.stringify(rec));
      out.push(`${site.id} ${q} title=${rec.title.slice(0, 40)} links=${links} bytes=${html.length}`);
    }
  }
  await browser.close();
  console.log(out.join('\n'));
  if (!out.some(l => /links=[1-9]/.test(l))) { console.error('no links found — challenge not passed'); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
