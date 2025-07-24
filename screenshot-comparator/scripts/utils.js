export function env(key) {
  const v = process.env[key];
  if (!v) {
    throw new Error("🆘 Add this env variable to .env file: " + key);
  }
  return v;
}

export async function retryWithBackoff(fn, retries = 2, delay = 5000, hardTimeout = 60000) {
  let attempt = 0;

  while (attempt < retries) {
    const label = `⏱️ attempt ${attempt + 1}`;
    const start = Date.now();

    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`⏰ Hard timeout after ${hardTimeout}ms`)),
            hardTimeout
          )
        )
      ]);
      const duration = Date.now() - start;
      console.log(`✅ ${label} succeeded in ${duration}ms`);
      return result;
    } catch (err) {
      const duration = Date.now() - start;

      if (
        (err.name === "TimeoutError" || err.message?.includes("Hard timeout")) &&
        attempt < retries - 1
      ) {
        console.warn(`⚠️ ${label} failed in ${duration}ms: ${err.message}`);
        console.warn(`🔁 Retrying in ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2;
        attempt++;
      } else {
        console.error(`❌ ${label} gave up after ${duration}ms: ${err.message}`);
        throw err;
      }
    }
  }
}

export async function gotoWithHardTimeout(
  page,
  url,
  waitUntil = "load",
  timeoutMs = 90000
) {
  return await Promise.race([
    page.goto(url, { waitUntil: waitUntil, timeout: timeoutMs }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`⏰ Hard timeout after ${timeoutMs}ms`)),
        timeoutMs + 2000
      )
    ),
  ]);
}
