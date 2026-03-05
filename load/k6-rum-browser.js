import { sleep } from "k6";
import { browser } from "k6/browser";

const FRONTEND_URL = __ENV.FRONTEND_URL || "http://localhost:5173";
const RUM_DURATION = __ENV.RUM_BROWSER_DURATION || "3m";
const RUM_VUS = Number(__ENV.RUM_BROWSER_VUS || 5);
const RUM_ANONYMOUS_RATE = Number(__ENV.RUM_BROWSER_ANONYMOUS_RATE || 0.05);
const RUM_STEPS_MIN = Number(__ENV.RUM_BROWSER_STEPS_MIN || 8);
const RUM_STEPS_MAX = Number(__ENV.RUM_BROWSER_STEPS_MAX || 20);
const RUM_IDLE_MIN_SECONDS = Number(__ENV.RUM_BROWSER_IDLE_MIN_SECONDS || 45);
const RUM_IDLE_MAX_SECONDS = Number(__ENV.RUM_BROWSER_IDLE_MAX_SECONDS || 180);
const APP_PATHS = ["/", "/journeys", "/appointments", "/exams", "/operations", "/patients"];
const AUTH_STORAGE_KEY = "hospital_demo_auth";

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomInt(min, max) {
  const safeMin = Math.ceil(min);
  const safeMax = Math.floor(max);
  if (safeMax <= safeMin) {
    return safeMin;
  }
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
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

async function waitForDemoUsers(page, timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const count = await page.locator(".demo-user-button").count();
    if (count > 0) {
      return count;
    }
    await page.waitForTimeout(300);
  }
  return 0;
}

async function waitForAuthenticatedState(page, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const currentUrl = String(page.url() || "");
    const hasAuth = await page
      .evaluate((storageKey) => Boolean(localStorage.getItem(storageKey)), AUTH_STORAGE_KEY)
      .catch(() => false);

    if (!currentUrl.includes("/login") || hasAuth) {
      return true;
    }

    await page.waitForTimeout(250);
  }
  return false;
}

async function tryDemoLogin(page) {
  await clickIfVisible(page, [
    "button:has-text('Acesso demonstracao')",
    "button:has-text('Login demo')",
    "button:has-text('Entrar demo')",
    "button:has-text('Entrar com demo')",
  ]);

  await page.waitForTimeout(450 + Math.random() * 900);
  let usersCount = await waitForDemoUsers(page, 16000);
  if (!usersCount) {
    await clickIfVisible(page, [
      "button:has-text('Acesso demonstracao')",
      "button:has-text('Login demo')",
      "button:has-text('Entrar demo')",
      "button:has-text('Entrar com demo')",
    ]);
    usersCount = await waitForDemoUsers(page, 8000);
  }
  if (!usersCount) {
    return false;
  }

  const target = randomInt(0, Math.min(usersCount - 1, 23));
  const targetUser = page.locator(".demo-user-button").nth(target);
  await targetUser.scrollIntoViewIfNeeded().catch(() => {});
  await targetUser.click().catch(() => {});

  return waitForAuthenticatedState(page, 20000);
}

async function apiFallbackDemoLogin(page) {
  const logged = await page
    .evaluate(async (storageKey) => {
      const roles = ["patient", "doctor", "receptionist", "admin"];
      const role = roles[Math.floor(Math.random() * roles.length)];
      const usersResponse = await fetch(`/api/auth/demo-users?role=${role}&limit=24`).catch(() => null);
      if (!usersResponse || !usersResponse.ok) {
        return false;
      }

      const usersData = await usersResponse.json().catch(() => ({}));
      const users = Array.isArray(usersData?.users) ? usersData.users : [];
      if (!users.length) {
        return false;
      }

      const user = users[Math.floor(Math.random() * users.length)];
      const loginResponse = await fetch("/api/auth/demo-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: user.id }),
      }).catch(() => null);

      if (!loginResponse || !loginResponse.ok) {
        return false;
      }

      const payload = await loginResponse.json().catch(() => ({}));
      if (!payload?.token || !payload?.user) {
        return false;
      }

      localStorage.setItem(
        storageKey,
        JSON.stringify({
          token: payload.token,
          user: payload.user,
        }),
      );
      return true;
    }, AUTH_STORAGE_KEY)
    .catch(() => false);

  if (!logged) {
    return false;
  }

  await page.goto(`${FRONTEND_URL}/`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  return waitForAuthenticatedState(page, 15000);
}

export default async function () {
  const page = await browser.newPage();

  try {
    await page.goto(`${FRONTEND_URL}/login`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(500 + Math.random() * 1200);

    const shouldStayAnonymous = Math.random() < clamp(RUM_ANONYMOUS_RATE, 0, 1);
    let isLoggedIn = false;

    if (!shouldStayAnonymous) {
      isLoggedIn = await tryDemoLogin(page);
      if (!isLoggedIn) {
        isLoggedIn = await apiFallbackDemoLogin(page);
      }
      if (!isLoggedIn) {
        await page.goto(`${FRONTEND_URL}/login`, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page.waitForTimeout(400 + Math.random() * 900);
        isLoggedIn = await tryDemoLogin(page);
      }
    }

    const hops = randomInt(clamp(RUM_STEPS_MIN, 1, 50), clamp(RUM_STEPS_MAX, 1, 80));
    for (let i = 0; i < hops; i += 1) {
      const path = isLoggedIn ? pickRandom(APP_PATHS) : "/login";
      await page.goto(`${FRONTEND_URL}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await page.waitForTimeout(900 + Math.random() * 2600);
    }

    const idleMin = clamp(RUM_IDLE_MIN_SECONDS, 1, 900);
    const idleMax = clamp(RUM_IDLE_MAX_SECONDS, idleMin, 1200);
    const idleSeconds = randomInt(idleMin, idleMax);
    await page.waitForTimeout(idleSeconds * 1000);
  } catch (_error) {
    // Erros sao esperados em testes de estresse.
  } finally {
    await page.close();
  }

  sleep(Math.random());
}
