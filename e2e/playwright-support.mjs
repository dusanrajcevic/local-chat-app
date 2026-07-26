export function playwrightBrowserIsMissingError(err) {
  const message = String(err?.message || err);
  return /Executable doesn't exist|Please run the following command to download new browsers|playwright install/i.test(
    message
  );
}

export async function launchChromium({ chromium, t, optional = false, executablePath = '' }) {
  try {
    return await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox']
    });
  } catch (err) {
    if (optional && !executablePath && playwrightBrowserIsMissingError(err)) {
      t.skip('Playwright Chromium is not installed; run `npx playwright install chromium` to enable this smoke test.');
      return null;
    }

    if (!executablePath && playwrightBrowserIsMissingError(err)) {
      throw new Error(
        'Playwright Chromium is required for this smoke test. Run `npx playwright install chromium` before retrying.',
        { cause: err }
      );
    }

    throw err;
  }
}

export function monitorBrowserFailures(page) {
  const failures = [];

  page.on('pageerror', (error) => {
    failures.push(`pageerror: ${error.stack || error.message}`);
  });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(`console.error: ${message.text()}`);
    }
  });

  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText || 'unknown failure';
    failures.push(`requestfailed: ${request.method()} ${request.url()} (${reason})`);
  });

  return failures;
}
