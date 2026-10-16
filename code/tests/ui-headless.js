// Runner headless pour public/test-ui.js — usage: node tests/ui-headless.js (serveur lancé, puppeteer-core requis)
// Lance Chrome headless, charge l'app sur localhost:3000, exécute le test,
// capture les console.log/warn et sort le rapport final.
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL     = 'http://localhost:3000/';
const TIMEOUT = 120000; // 2 min max (30 runs × ~2s/run)

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  const lines = [];
  page.on('console', msg => {
    const text = msg.text();
    lines.push(text);
    process.stdout.write(text + '\n');
  });
  page.on('pageerror', err => {
    process.stdout.write('PAGE ERROR: ' + err.message + '\n');
  });

  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });

  // Lance le test et attend la ligne finale du rapport
  await page.evaluate(async () => {
    const src = await fetch('/test-ui.js').then(r => r.text());
    eval(src); // eslint-disable-line no-eval
    // Donne le temps à la Promise async de se terminer
    await new Promise(r => setTimeout(r, 10));
  });

  // Attend que le rapport final apparaisse (ligne contenant '═══')
  const done = await new Promise(resolve => {
    let found = false;
    const iv = setInterval(() => {
      if (lines.some(l => l.includes('RAPPORT FINAL'))) {
        clearInterval(iv); found = true; resolve(true);
      }
    }, 500);
    setTimeout(() => { clearInterval(iv); if (!found) resolve(false); }, TIMEOUT);
  });

  await browser.close();
  if (!done) { console.error('TIMEOUT — rapport non reçu'); process.exit(2); }

  // Code de sortie : 0 si 0 échec, 1 sinon
  const failLine = lines.find(l => /^❌ Échoué/.test(l));
  const failCount = failLine ? parseInt(failLine.match(/\d+/)[0]) : 0;
  process.exit(failCount > 0 ? 1 : 0);
})();
