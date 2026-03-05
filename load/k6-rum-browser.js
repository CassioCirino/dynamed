import { sleep } from "k6";
import { browser } from "k6/browser";
import { Counter, Trend } from "k6/metrics";

const FRONTEND_URL = __ENV.FRONTEND_URL || "http://localhost:5173";
const RUM_DURATION = __ENV.RUM_BROWSER_DURATION || "20m";
const RUM_VUS = clampNumber(Number(__ENV.RUM_BROWSER_VUS || 4), 1, 60);
const RUM_SESSIONS_PER_MINUTE = clampNumber(Number(__ENV.RUM_BROWSER_SESSIONS_PER_MINUTE || 0), 0, 1200);
const RUM_PREALLOCATED_VUS = clampNumber(
  Number(__ENV.RUM_BROWSER_PREALLOCATED_VUS || Math.max(2, Math.ceil(RUM_SESSIONS_PER_MINUTE / 2)) || 4),
  1,
  300,
);
const RUM_MAX_VUS = clampNumber(
  Number(__ENV.RUM_BROWSER_MAX_VUS || Math.max(RUM_PREALLOCATED_VUS + 2, Math.ceil(RUM_SESSIONS_PER_MINUTE * 2)) || 20),
  RUM_PREALLOCATED_VUS,
  1000,
);
const RUM_ANONYMOUS_RATE = clampNumber(Number(__ENV.RUM_BROWSER_ANONYMOUS_RATE || 0), 0, 1);
const RUM_STEPS_MIN = clampNumber(Number(__ENV.RUM_BROWSER_STEPS_MIN || 12), 1, 120);
const RUM_STEPS_MAX = clampNumber(Number(__ENV.RUM_BROWSER_STEPS_MAX || 28), RUM_STEPS_MIN, 160);
const RUM_MIN_ACTIONS = clampNumber(Number(__ENV.RUM_BROWSER_MIN_ACTIONS || 10), 1, 80);
const RUM_MIN_SESSION_SECONDS = clampNumber(Number(__ENV.RUM_BROWSER_MIN_SESSION_SECONDS || 180), 30, 1800);
const RUM_IDLE_MIN_SECONDS = clampNumber(Number(__ENV.RUM_BROWSER_IDLE_MIN_SECONDS || 45), 1, 1800);
const RUM_IDLE_MAX_SECONDS = clampNumber(Number(__ENV.RUM_BROWSER_IDLE_MAX_SECONDS || 180), RUM_IDLE_MIN_SECONDS, 2400);
const RUM_ROLE_WEIGHTS_RAW = __ENV.RUM_BROWSER_ROLE_WEIGHTS || "patient:60,doctor:20,receptionist:15,admin:5";
const RUM_USER_AGENT =
  __ENV.RUM_BROWSER_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const APP_PATHS = ["/", "/journeys", "/appointments", "/exams", "/operations", "/patients"];
const AUTH_STORAGE_KEY = "hospital_demo_auth";

const ROLE_LABEL = {
  patient: "Paciente",
  doctor: "Medico",
  receptionist: "Recepcao",
  admin: "Operacoes",
};

const loginSuccess = new Counter("rum_login_success");
const loginFailure = new Counter("rum_login_failure");
const identifySuccess = new Counter("rum_identify_success");
const identifyFailure = new Counter("rum_identify_failure");
const iterationErrors = new Counter("rum_iteration_errors");
const actionsPerIteration = new Trend("rum_actions_per_iteration");
const durationPerIteration = new Trend("rum_iteration_duration_seconds");

const browserOptions = {
  browser: {
    type: "chromium",
  },
};

const rumScenario =
  RUM_SESSIONS_PER_MINUTE > 0
    ? {
        executor: "constant-arrival-rate",
        rate: RUM_SESSIONS_PER_MINUTE,
        timeUnit: "1m",
        preAllocatedVUs: RUM_PREALLOCATED_VUS,
        maxVUs: RUM_MAX_VUS,
        duration: RUM_DURATION,
        gracefulStop: "30s",
        options: browserOptions,
      }
    : {
        executor: "constant-vus",
        vus: RUM_VUS,
        duration: RUM_DURATION,
        gracefulStop: "30s",
        options: browserOptions,
      };

export const options = {
  scenarios: {
    frontend_rum: rumScenario,
  },
};

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
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
    { role: "patient", weight: 60 },
    { role: "doctor", weight: 20 },
    { role: "receptionist", weight: 15 },
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
    if (!Object.prototype.hasOwnProperty.call(ROLE_LABEL, role)) {
      continue;
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }
    parsed.push({ role, weight });
  }

  return parsed.length ? parsed : defaults;
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

async function countElements(page, selector) {
  return page
    .evaluate((sel) => document.querySelectorAll(sel).length, selector)
    .catch(() => 0);
}

async function clickIfVisible(page, selectors) {
  for (const selector of selectors) {
    if ((await countElements(page, selector)) > 0) {
      const loc = page.locator(selector);
      await loc.first().click().catch(() => {});
      return true;
    }
  }
  return false;
}

async function clickRandomMenuLink(page) {
  const menuCount = await countElements(page, ".menu-link");
  if (menuCount <= 0) {
    return false;
  }
  const target = randomInt(0, menuCount - 1);
  await page.locator(".menu-link").nth(target).click({ timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(500 + Math.random() * 1200);
  return true;
}

async function selectDifferentOptionByIndex(page, selector, index = 0) {
  const value = await page
    .evaluate(
      ({ sel, idx }) => {
        const all = Array.from(document.querySelectorAll(sel));
        const element = all[idx];
        if (!element || element.tagName !== "SELECT") {
          return "";
        }
        const select = element;
        const options = Array.from(select.options)
          .map((item) => item.value)
          .filter((item) => item !== select.value);
        if (!options.length) {
          return "";
        }
        return options[Math.floor(Math.random() * options.length)];
      },
      { sel: selector, idx: index },
    )
    .catch(() => "");

  if (!value) {
    return false;
  }

  const target = page.locator(selector).nth(index);
  await target.selectOption(value).catch(async () => {
    await page
      .evaluate(
        ({ sel, idx, val }) => {
          const all = Array.from(document.querySelectorAll(sel));
          const element = all[idx];
          if (!element || element.tagName !== "SELECT") {
            return;
          }
          element.value = val;
          element.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { sel: selector, idx: index, val: value },
      )
      .catch(() => {});
  });
  await page.waitForTimeout(350 + Math.random() * 1000);
  return true;
}

async function fillInputIfVisible(page, selectors, value) {
  for (const selector of selectors) {
    if ((await countElements(page, selector)) <= 0) {
      continue;
    }
    const target = page.locator(selector).first();
    await target.click().catch(() => {});
    await target.fill(String(value || "")).catch(() => {});
    await page.waitForTimeout(250 + Math.random() * 700);
    return true;
  }
  return false;
}

async function maybeScroll(page) {
  if (Math.random() >= 0.7) {
    return false;
  }
  await page.evaluate(() => window.scrollTo(0, Math.floor(Math.random() * document.body.scrollHeight))).catch(() => {});
  await page.waitForTimeout(200 + Math.random() * 700);
  return true;
}

async function waitForDemoUsers(page, timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const count = await countElements(page, ".demo-user-button");
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

async function readUserTagFromStorage(page) {
  return page
    .evaluate((storageKey) => {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        return "";
      }

      const auth = JSON.parse(raw);
      const user = auth?.user || null;
      if (!user) {
        return "";
      }

      const role = String(user.role || "usuario").trim() || "usuario";
      const identity = String(user.full_name || user.name || user.email || user.id || "desconhecido").trim();
      return identity ? `${role}:${identity}` : "";
    }, AUTH_STORAGE_KEY)
    .catch(() => "");
}

async function ensureRumIdentify(page, userTag, timeoutMs = 10000) {
  if (!userTag) {
    return false;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const identified = await page
      .evaluate((tag) => {
        if (!window.dtrum) {
          return false;
        }
        let ok = false;
        if (typeof window.dtrum.identifyUser === "function") {
          window.dtrum.identifyUser(tag);
          ok = true;
        }
        if (typeof window.dtrum.setUserTag === "function") {
          window.dtrum.setUserTag(tag);
          ok = true;
        }
        if (typeof window.dtrum.sendSessionProperties === "function") {
          const role = String(tag || "").split(":")[0] || "usuario";
          window.dtrum.sendSessionProperties({
            userTag: tag,
            userRole: role,
          });
          ok = true;
        }
        return ok;
      }, userTag)
      .catch(() => false);

    if (identified) {
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

  await page.waitForTimeout(500 + Math.random() * 900);

  let usersCount = await waitForDemoUsers(page, 15000);
  if (!usersCount) {
    await clickIfVisible(page, ["button:has-text('Acesso demonstracao')"]);
    usersCount = await waitForDemoUsers(page, 8000);
  }

  if (!usersCount) {
    return { loggedIn: false, userTag: "", identifyOk: false };
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

  const loggedIn = await waitForAuthenticatedState(page, 22000);
  if (!loggedIn) {
    return { loggedIn: false, userTag: "", identifyOk: false };
  }

  const userTag = await readUserTagFromStorage(page);
  const identifyOk = await ensureRumIdentify(page, userTag, 9000);
  return { loggedIn: true, userTag, identifyOk };
}

async function apiFallbackDemoLogin(page, preferredRole) {
  const loginResult = await page
    .evaluate(async (storageKey, role) => {
      const usersResponse = await fetch(`/api/auth/demo-users?role=${role}&limit=24`).catch(() => null);
      if (!usersResponse || !usersResponse.ok) {
        return { ok: false, userTag: "" };
      }

      const usersData = await usersResponse.json().catch(() => ({}));
      const users = Array.isArray(usersData?.users) ? usersData.users : [];
      if (!users.length) {
        return { ok: false, userTag: "" };
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
        return { ok: false, userTag: "" };
      }

      const payload = await loginResponse.json().catch(() => ({}));
      if (!payload?.token || !payload?.user) {
        return { ok: false, userTag: "" };
      }

      localStorage.setItem(
        storageKey,
        JSON.stringify({
          token: payload.token,
          user: payload.user,
        }),
      );

      const roleSafe = String(payload.user.role || "usuario").trim() || "usuario";
      const identitySafe = String(
        payload.user.full_name || payload.user.name || payload.user.email || payload.user.id || "desconhecido",
      ).trim();

      return {
        ok: true,
        userTag: identitySafe ? `${roleSafe}:${identitySafe}` : "",
      };
    }, AUTH_STORAGE_KEY, preferredRole || "patient")
    .catch(() => ({ ok: false, userTag: "" }));

  if (!loginResult?.ok) {
    return { loggedIn: false, userTag: "", identifyOk: false };
  }

  await page.goto(`${FRONTEND_URL}/`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const loggedIn = await waitForAuthenticatedState(page, 16000);
  if (!loggedIn) {
    return { loggedIn: false, userTag: "", identifyOk: false };
  }

  const identifyOk = await ensureRumIdentify(page, loginResult.userTag, 9000);
  return { loggedIn: true, userTag: loginResult.userTag, identifyOk };
}

async function doLoggedInAction(page) {
  let performed = 0;

  if (Math.random() < 0.8) {
    if (await clickRandomMenuLink(page)) {
      performed += 1;
    }
  }

  const currentUrl = String(page.url() || "");

  if (currentUrl.includes("/journeys")) {
    if (await clickIfVisible(page, [".journey-card button", "button:has-text('Ir para')"])) {
      performed += 1;
    }
  } else if (currentUrl.includes("/appointments")) {
    if (await selectDifferentOptionByIndex(page, ".page-header select", 0)) performed += 1;
    if (await selectDifferentOptionByIndex(page, ".page-header select", 1)) performed += 1;
    if (await selectDifferentOptionByIndex(page, ".table-panel tbody select", 0)) performed += 1;
    if (await clickIfVisible(page, ["button.time-now-button", "button:has-text('Usar hora atual')"])) performed += 1;
  } else if (currentUrl.includes("/exams")) {
    if (await selectDifferentOptionByIndex(page, ".page-header select", 0)) performed += 1;
    if (await selectDifferentOptionByIndex(page, ".table-panel tbody select", 0)) performed += 1;
    if (await clickIfVisible(page, ["button:has-text('Solicitar')"])) performed += 1;
  } else if (currentUrl.includes("/patients")) {
    const searchValue = pickRandom(["ma", "jo", "ca", "dr", "sil", "sou"]);
    if (await fillInputIfVisible(page, ["input[placeholder*='Buscar paciente']", ".page-header input"], searchValue)) {
      performed += 1;
    }
    if (await clickIfVisible(page, [".list-panel li button", ".list-panel button"])) performed += 1;
  } else if (currentUrl.includes("/operations")) {
    if (await clickIfVisible(page, ["button:has-text('Atualizar agora')"])) performed += 1;
    if (Math.random() < 0.15) {
      if (
        await fillInputIfVisible(
          page,
          [".form-grid input:first-of-type", "input[value*='Alerta manual']", ".form-grid input"],
          `Alerta sintetico ${randomInt(10, 999)}`,
        )
      ) {
        performed += 1;
      }
      if (await clickIfVisible(page, ["button:has-text('Registrar incidente')"])) performed += 1;
    }
  } else {
    if (await clickIfVisible(page, ["button:has-text('Atualizar agora')", ".menu-link"])) {
      performed += 1;
    }
  }

  if (Math.random() < 0.3) {
    const path = pickRandom(APP_PATHS);
    await page.goto(`${FRONTEND_URL}${path}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(500 + Math.random() * 1200);
    performed += 1;
  }

  if (await clickIfVisible(page, ["button:has-text('Atualizar')", "button:has-text('Buscar')", ".panel button"])) {
    performed += 1;
  }

  if (await maybeScroll(page)) {
    performed += 1;
  }

  return Math.max(1, performed);
}

async function doAnonymousAction(page) {
  let performed = 0;
  await page.goto(`${FRONTEND_URL}/login`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  performed += 1;

  if (await clickIfVisible(page, [
    "button:has-text('Entrar com e-mail')",
    "button:has-text('Cadastrar paciente')",
    "button:has-text('Acesso demonstracao')",
    ".auth-tabs .tab-button",
  ])) {
    performed += 1;
  }

  if (await fillInputIfVisible(page, ["input[type='email']", "input[placeholder*='e-mail']"], "anon@hospital.local")) {
    performed += 1;
  }

  await page.waitForTimeout(500 + Math.random() * 1000);
  if (await clickIfVisible(page, [
    "button:has-text('Entrar com e-mail')",
    "button:has-text('Cadastrar paciente')",
    "button:has-text('Acesso demonstracao')",
  ])) {
    performed += 1;
  }

  if (await maybeScroll(page)) {
    performed += 1;
  }

  await page.waitForTimeout(450 + Math.random() * 1000);
  return Math.max(1, performed);
}

async function openContextAndPage() {
  const viewport = {
    width: randomInt(1280, 1920),
    height: randomInt(720, 1080),
  };

  try {
    const context = await browser.newContext({
      userAgent: RUM_USER_AGENT,
      viewport,
    });
    const page = await context.newPage();
    return { context, page };
  } catch {
    const page = await browser.newPage();
    return { context: null, page };
  }
}

export default async function () {
  const startedAt = Date.now();
  const preferredRole = pickWeightedRole(RUM_ROLE_WEIGHTS);
  const shouldStayAnonymous = Math.random() < RUM_ANONYMOUS_RATE;
  const anonymousAllowed = shouldStayAnonymous || RUM_ANONYMOUS_RATE > 0;
  console.error(
    `[rum-iter-start] role=${preferredRole} anonymousCandidate=${shouldStayAnonymous} anonymousAllowed=${anonymousAllowed}`,
  );

  let context = null;
  let page = null;
  let loggedIn = false;
  let identifyOk = false;
  let userTag = "";
  let actionCount = 0;

  try {
    const opened = await openContextAndPage();
    context = opened.context;
    page = opened.page;

    await page.goto(`${FRONTEND_URL}/login`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(600 + Math.random() * 1100);

    if (!shouldStayAnonymous) {
      for (let attempt = 0; attempt < 3 && !loggedIn; attempt += 1) {
        let loginState = await apiFallbackDemoLogin(page, preferredRole);
        if (!loginState.loggedIn) {
          loginState = await tryDemoLogin(page, preferredRole);
        }

        loggedIn = loginState.loggedIn;
        identifyOk = loginState.identifyOk;
        userTag = loginState.userTag;

        if (!loggedIn) {
          await page.goto(`${FRONTEND_URL}/login`, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          await page.waitForTimeout(400 + Math.random() * 900);
        }
      }

      if (loggedIn) {
        loginSuccess.add(1);
      } else {
        loginFailure.add(1);
      }

      if (loggedIn && !identifyOk) {
        identifyOk = await ensureRumIdentify(page, userTag, 9000);
      }

      if (loggedIn && identifyOk) {
        identifySuccess.add(1);
      } else if (loggedIn) {
        identifyFailure.add(1);
      }

      console.error(
        `[rum-login] role=${preferredRole} loggedIn=${loggedIn} identify=${identifyOk} anonymousAllowed=${anonymousAllowed}`,
      );

      if (!loggedIn && !anonymousAllowed) {
        throw new Error("login_failed_with_anonymous_disabled");
      }
    }

    const targetActions = Math.max(RUM_MIN_ACTIONS, randomInt(RUM_STEPS_MIN, RUM_STEPS_MAX));
    let attemptsLeft = targetActions * 4;

    while (actionCount < targetActions && attemptsLeft > 0) {
      attemptsLeft -= 1;
      if (loggedIn) {
        actionCount += await doLoggedInAction(page);
      } else {
        if (!anonymousAllowed) {
          throw new Error("anonymous_flow_blocked_by_configuration");
        }
        actionCount += await doAnonymousAction(page);
      }

      if (loggedIn && userTag) {
        await ensureRumIdentify(page, userTag, 1200);
      }

      if (actionCount % 5 === 0) {
        console.error(
          `[rum-step] role=${preferredRole} loggedIn=${loggedIn} identify=${identifyOk} actions=${actionCount}/${targetActions}`,
        );
      }
    }

    actionsPerIteration.add(actionCount);

    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    if (elapsedSeconds < RUM_MIN_SESSION_SECONDS) {
      await page.waitForTimeout((RUM_MIN_SESSION_SECONDS - elapsedSeconds) * 1000);
    }

    const idleSeconds = randomInt(RUM_IDLE_MIN_SECONDS, RUM_IDLE_MAX_SECONDS);
    await page.waitForTimeout(idleSeconds * 1000);

    const totalSeconds = (Date.now() - startedAt) / 1000;
    durationPerIteration.add(totalSeconds);

    console.error(
      `[rum-iter] role=${preferredRole} loggedIn=${loggedIn} identify=${identifyOk} actions=${actionCount} durationSec=${Math.round(totalSeconds)}`,
    );
  } catch (error) {
    iterationErrors.add(1);
    console.error(`[rum-iter-error] role=${preferredRole} message=${String(error?.message || error)}`);
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (context) {
      await context.close().catch(() => {});
    }
  }

  sleep(Math.random());
}
