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
const RUM_ROLE_WEIGHTS_RAW = __ENV.RUM_BROWSER_ROLE_WEIGHTS || "patient:55,doctor:20,receptionist:20,admin:5";
const APP_PATHS = ["/", "/journeys", "/appointments", "/exams", "/operations", "/patients"];
const AUTH_STORAGE_KEY = "hospital_demo_auth";
const ROLE_LABEL = {
  patient: "Paciente",
  doctor: "Medico",
  receptionist: "Recepcao",
  admin: "Operacoes",
};

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

function parseRoleWeights(rawValue) {
  const defaults = [
    { role: "patient", weight: 55 },
    { role: "doctor", weight: 20 },
    { role: "receptionist", weight: 20 },
    { role: "admin", weight: 5 },
  ];
  const chunks = String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!chunks.length) {
    return defaults;
  }

  const parsed = [];
  for (const chunk of chunks) {
    const [roleRaw, weightRaw] = chunk.split(":");
    const role = String(roleRaw || "").trim();
    const weight = Number(String(weightRaw || "").trim());
    if (!["patient", "doctor", "receptionist", "admin"].includes(role)) {
      continue;
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }
    parsed.push({ role, weight });
  }

  if (!parsed.length) {
    return defaults;
  }

  return parsed;
}

function pickWeightedRole(weights) {
  const safeWeights = Array.isArray(weights) && weights.length ? weights : parseRoleWeights("");
  const total = safeWeights.reduce((acc, item) => acc + Number(item.weight || 0), 0);
  if (total <= 0) {
    return "patient";
  }

  let cursor = Math.random() * total;
  for (const item of safeWeights) {
    cursor -= Number(item.weight || 0);
    if (cursor <= 0) {
      return item.role;
    }
  }

  return safeWeights[safeWeights.length - 1].role;
}

const RUM_ROLE_WEIGHTS = parseRoleWeights(RUM_ROLE_WEIGHTS_RAW);

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

async function clickDemoUserByRole(page, role) {
  const expectedLabel = ROLE_LABEL[String(role || "").trim()] || "";
  if (!expectedLabel) {
    return false;
  }

  return page
    .evaluate((label) => {
      const cards = Array.from(document.querySelectorAll(".demo-card"));
      const targetCard = cards.find((card) => {
        const title = String(card.querySelector("h2")?.textContent || "")
          .trim()
          .toLowerCase();
        return title.includes(label.toLowerCase());
      });

      if (!targetCard) {
        return false;
      }

      const buttons = Array.from(targetCard.querySelectorAll(".demo-user-button"));
      if (!buttons.length) {
        return false;
      }

      const chosen = buttons[Math.floor(Math.random() * buttons.length)];
      if (!chosen) {
        return false;
      }

      chosen.scrollIntoView({ block: "center" });
      chosen.click();
      return true;
    }, expectedLabel)
    .catch(() => false);
}

async function tryDemoLogin(page, preferredRole) {
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

  let clicked = false;
  if (preferredRole) {
    clicked = await clickDemoUserByRole(page, preferredRole);
  }

  if (!clicked) {
    const target = randomInt(0, Math.min(usersCount - 1, 23));
    const targetUser = page.locator(".demo-user-button").nth(target);
    await targetUser.scrollIntoViewIfNeeded().catch(() => {});
    await targetUser.click().catch(() => {});
  }

  return waitForAuthenticatedState(page, 20000);
}

async function apiFallbackDemoLogin(page, preferredRole) {
  const logged = await page
    .evaluate(async (storageKey, role) => {
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
    }, AUTH_STORAGE_KEY, preferredRole || "patient")
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

async function doLoggedInStep(page) {
  const menuCount = await page.locator(".menu-link").count().catch(() => 0);
  if (menuCount > 0) {
    const target = randomInt(0, menuCount - 1);
    await page.locator(".menu-link").nth(target).click().catch(() => {});
    await page.waitForTimeout(600 + Math.random() * 1800);
  } else {
    const path = pickRandom(APP_PATHS);
    await page.goto(`${FRONTEND_URL}${path}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(900 + Math.random() * 2600);
  }

  if (Math.random() < 0.45) {
    await clickIfVisible(page, [
      "button:has-text('Atualizar')",
      "button:has-text('Buscar')",
      "button:has-text('Filtrar')",
      "button:has-text('Salvar')",
      "button:has-text('Criar')",
      ".panel button",
      ".card button",
    ]);
    await page.waitForTimeout(350 + Math.random() * 1000);
  }

  if (Math.random() < 0.6) {
    await page.evaluate(() => window.scrollTo(0, Math.floor(Math.random() * document.body.scrollHeight))).catch(() => {});
    await page.waitForTimeout(250 + Math.random() * 700);
  }
}

async function doAnonymousStep(page) {
  await page.goto(`${FRONTEND_URL}/login`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(500 + Math.random() * 1200);

  await clickIfVisible(page, [
    "button:has-text('Entrar com e-mail')",
    "button:has-text('Cadastrar paciente')",
    "button:has-text('Acesso demonstracao')",
  ]);

  if (Math.random() < 0.65) {
    const fake = randomInt(1000, 9999);
    await page.locator(".auth-form-credentials input[type='email']").first().fill(`visitante.${fake}@hospital.local`).catch(() => {});
    await page.locator(".auth-form-credentials input[type='password']").first().fill("123456").catch(() => {});
    await clickIfVisible(page, ["form.auth-form-credentials button:has-text('Entrar')"]);
  }

  await page.waitForTimeout(650 + Math.random() * 1800);
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
    const preferredRole = pickWeightedRole(RUM_ROLE_WEIGHTS);
    let isLoggedIn = false;

    if (!shouldStayAnonymous) {
      isLoggedIn = await tryDemoLogin(page, preferredRole);
      if (!isLoggedIn) {
        isLoggedIn = await apiFallbackDemoLogin(page, preferredRole);
      }
      if (!isLoggedIn) {
        await page.goto(`${FRONTEND_URL}/login`, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page.waitForTimeout(400 + Math.random() * 900);
        isLoggedIn = await tryDemoLogin(page, preferredRole);
      }
    }

    const hops = randomInt(clamp(RUM_STEPS_MIN, 1, 50), clamp(RUM_STEPS_MAX, 1, 80));
    for (let i = 0; i < hops; i += 1) {
      if (isLoggedIn) {
        await doLoggedInStep(page);
      } else {
        await doAnonymousStep(page);
      }
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
