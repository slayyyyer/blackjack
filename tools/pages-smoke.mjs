#!/usr/bin/env node
/**
 * Post-deploy smoke test for the GitHub Pages build.
 *
 * SMOKE_URL must point at the deployed app. The Pages workflow supplies the
 * deployment URL, so this script never has to guess the repository's Pages
 * address. It opens the Play tab, deals until a real player decision exists,
 * checks that the table, cards, and action buttons are rendered, then stands
 * and waits for the round to appear in the history.
 *
 * Run locally with:
 *   SMOKE_URL=http://127.0.0.1:8080/ npm run test:smoke
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const SMOKE_URL = process.env.SMOKE_URL;
if (!SMOKE_URL) {
  console.error('[pages-smoke] SMOKE_URL is required.');
  process.exit(2);
}

const NAV_TIMEOUT_MS = 30_000;
const FLOW_TIMEOUT_MS = 15_000;
const NAV_ATTEMPTS = 4;
const MAX_DEALS = 8;
const ACTION_LABELS = {
  hit: 'Hit',
  stand: 'Stand',
  double: 'Double',
  split: 'Split',
  surrender: 'Surrender',
};

function log(message) {
  console.log(`[pages-smoke] ${message}`);
}

async function openWithRetry(page, url) {
  let lastError;
  for (let attempt = 1; attempt <= NAV_ATTEMPTS; attempt++) {
    try {
      const response = await page.goto(url, {
        waitUntil: 'load',
        timeout: NAV_TIMEOUT_MS,
      });
      if (response?.ok()) return;
      lastError = new Error(`HTTP ${response?.status() ?? 'no response'}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < NAV_ATTEMPTS) {
      const delay = attempt * 2_000;
      log(`load attempt ${attempt} failed (${lastError.message}); retrying in ${delay}ms`);
      await page.waitForTimeout(delay);
    }
  }
  throw lastError;
}

async function readTableState(page) {
  return page.evaluate(() => {
    const deal = document.querySelector('#play-deal');
    const insurance = document.querySelector('#play-insurance');
    const actions = document.querySelector('#play-actions');
    const enabled = [...document.querySelectorAll('[data-play-action]')]
      .filter((button) => !button.disabled)
      .map((button) => button.dataset.playAction);
    const historyRows = [...document.querySelectorAll('.history-table tbody tr')]
      .filter((row) => !row.querySelector('.empty-cell')).length;

    return {
      insuranceOffered: Boolean(insurance && !insurance.hidden),
      actionBarVisible: Boolean(actions && !actions.hidden),
      enabled,
      dealText: deal?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      dealReady: Boolean(deal && !deal.disabled),
      playerCards: document.querySelectorAll('#play-hand-area .playing-card').length,
      dealerCards: document.querySelectorAll('#play-dealer-cards .playing-card').length,
      hiddenHole: document.querySelectorAll('#play-dealer-cards .playing-card.is-back').length,
      historyRows,
      message: document.querySelector('#play-message')?.textContent?.trim() ?? '',
    };
  });
}

async function waitForDealReady(page) {
  await page.waitForFunction(() => {
    const deal = document.querySelector('#play-deal');
    return deal instanceof HTMLButtonElement && !deal.disabled;
  }, undefined, { timeout: FLOW_TIMEOUT_MS });
}

async function waitForRoundReady(page) {
  await page.waitForFunction(() => {
    const insurance = document.querySelector('#play-insurance');
    const hasAction = [...document.querySelectorAll('[data-play-action]')]
      .some((button) => !button.disabled);
    const deal = document.querySelector('#play-deal');
    const dealNext = deal && !deal.disabled && /next/i.test(deal.textContent ?? '');
    return (insurance && !insurance.hidden) || hasAction || dealNext;
  }, undefined, { timeout: FLOW_TIMEOUT_MS });
}

async function dealUntilDecision(page) {
  for (let hand = 1; hand <= MAX_DEALS; hand++) {
    await waitForDealReady(page);
    log(`dealing hand ${hand}`);
    await page.locator('#play-deal').click();

    await page.waitForFunction(
      () => document.querySelectorAll('#play-hand-area .playing-card').length >= 2,
      undefined,
      { timeout: FLOW_TIMEOUT_MS },
    );
    await waitForRoundReady(page);

    let state = await readTableState(page);
    if (state.insuranceOffered) {
      log('insurance offered; declining');
      await page.locator('#play-insurance-decline').click();
      await page.waitForFunction(() => {
        const insurance = document.querySelector('#play-insurance');
        const hasAction = [...document.querySelectorAll('[data-play-action]')]
          .some((button) => !button.disabled);
        const deal = document.querySelector('#play-deal');
        const dealNext = deal && !deal.disabled && /next/i.test(deal.textContent ?? '');
        return !(insurance && !insurance.hidden) && (hasAction || dealNext);
      }, undefined, { timeout: FLOW_TIMEOUT_MS });
      state = await readTableState(page);
    }

    if (state.enabled.length > 0) return { hand, state };
    if (!state.dealReady) {
      throw new Error(`hand ${hand} settled without a player decision: ${state.message}`);
    }
  }
  throw new Error(`no player decision appeared within ${MAX_DEALS} deals`);
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  colorScheme: 'dark',
});
const pageErrors = [];
const consoleErrors = [];

page.on('pageerror', (error) => pageErrors.push(`uncaught exception: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('response', (response) => {
  const type = response.request().resourceType();
  if (response.status() >= 400 && ['document', 'script', 'stylesheet'].includes(type)) {
    pageErrors.push(`HTTP ${response.status()} for ${type} ${response.url()}`);
  }
});

try {
  log(`loading ${SMOKE_URL}`);
  await openWithRetry(page, SMOKE_URL);
  // A failed navigation attempt can leave a 404 in the buffers even after a
  // later retry succeeds. Only errors from the loaded app matter.
  pageErrors.length = 0;
  consoleErrors.length = 0;
  assert.match(await page.title(), /Blackjack Lab/, 'page title identifies Blackjack Lab');

  await page.getByRole('tab', { name: /Play/i }).click();

  const table = page.locator('section[aria-label="Blackjack table"]');
  await table.waitFor({ state: 'visible' });
  const tableBox = await table.boundingBox();
  assert.ok(
    tableBox && tableBox.width >= 300 && tableBox.height >= 300,
    `table has a visible layout (${tableBox?.width ?? 0}x${tableBox?.height ?? 0})`,
  );

  const styles = await page.evaluate(() => {
    const sheets = [...document.styleSheets];
    let rules = 0;
    for (const sheet of sheets) {
      try {
        rules += sheet.cssRules.length;
      } catch {
        // Cross-origin stylesheets are not readable; the app's own sheet is.
      }
    }
    return { sheets: sheets.length, rules };
  });
  assert.ok(styles.sheets > 0 && styles.rules > 0, 'the app stylesheet loaded');

  const actionButtons = page.locator('[data-play-action]');
  assert.equal(await actionButtons.count(), 5, 'five player action buttons render');
  for (const [id, label] of Object.entries(ACTION_LABELS)) {
    const button = page.locator(`[data-play-action="${id}"]`);
    assert.equal(await button.count(), 1, `${label} action exists`);
    assert.ok(await button.isVisible(), `${label} action is visible`);
    assert.match(
      (await button.textContent())?.replace(/\s+/g, ' ').trim() ?? '',
      new RegExp(label, 'i'),
      `${label} action is labelled`,
    );
  }

  const { hand, state } = await dealUntilDecision(page);
  log(
    `hand ${hand}: ${state.playerCards} player cards, ${state.dealerCards} dealer cards, `
    + `actions [${state.enabled.join(', ')}]`,
  );

  assert.ok(state.actionBarVisible, 'action bar is visible');
  assert.ok(state.playerCards >= 2, 'player cards are rendered');
  assert.ok(state.dealerCards >= 2, 'dealer cards are rendered');
  assert.equal(state.hiddenHole, 1, 'dealer hole card is face down');
  assert.ok(state.enabled.includes('stand'), 'stand is available on a player decision');

  await page.locator('[data-play-action="stand"]').click();
  await page.waitForFunction(() => {
    const deal = document.querySelector('#play-deal');
    const rows = [...document.querySelectorAll('.history-table tbody tr')]
      .filter((row) => !row.querySelector('.empty-cell')).length;
    return deal && !deal.disabled && /next/i.test(deal.textContent ?? '') && rows > 0;
  }, undefined, { timeout: FLOW_TIMEOUT_MS });
  const settled = await readTableState(page);
  assert.ok(settled.historyRows >= 1, 'the settled hand appears in history');

  if (pageErrors.length > 0) {
    throw new Error(`page errors:\n  ${pageErrors.join('\n  ')}`);
  }
  if (consoleErrors.length > 0) {
    log(`console errors (not fatal): ${consoleErrors.join(' | ')}`);
  }

  log(`PASS: table, cards, actions, and settlement rendered at ${SMOKE_URL}`);
} catch (error) {
  console.error(`[pages-smoke] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
