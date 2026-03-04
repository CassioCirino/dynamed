import { sleep } from "k6";
import { browser } from "k6/browser";

const FRONTEND_URL = __ENV.FRONTEND_URL || "http://frontend";
const RUM_DURATION = __ENV.RUM_BROWSER_DURATION || "3m";
const RUM_VUS = Number(__ENV.RUM_BROWSER_VUS || 5);

export const options = {
  scenarios: {
    frontend_rum: {
      executor: "constant-vus",
      vus: RUM_VUS,
      duration: RUM_DURATION,
      options: {
        browser: {
          type: "chromium",
        },
      },
    },
  },
};

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

async function clickIfVisible(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector);
    if ((await loc.count()) > 0) {
      await loc.first().click().catch(() => {});
      return true;
    }
  }
  return false;
}

export default async function () {
  const page = await browser.newPage();

  try {
    await page.goto(FRONTEND_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(500 + Math.random() * 1200);

    await clickIfVisible(page, [
      "button:has-text('Login demo')",
      "button:has-text('Entrar demo')",
      "button:has-text('Entrar com demo')",
    ]);

    await page.waitForTimeout(300 + Math.random() * 900);

    await clickIfVisible(page, [
      "button:has-text('Paciente')",
      "button:has-text('Médico')",
      "button:has-text('Medico')",
      "button:has-text('Recepção')",
      "button:has-text('Recepcao')",
    ]);

    const paths = ["/jornadas", "/atendimentos", "/exames", "/operacoes", "/pacientes"];
    const hops = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < hops; i += 1) {
      const path = pickRandom(paths);
      await page.goto(`${FRONTEND_URL}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await page.waitForTimeout(600 + Math.random() * 1500);
    }
  } catch (_) {
    // Errors are expected in stress runs; keep load going.
  } finally {
    await page.close();
  }

  sleep(Math.random());
}
