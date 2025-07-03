export function env(key) {
  const v = process.env[key];
  if (!v) 
  {
      throw new Error("🆘 Add this env variable to .env file: " + key);
  }
  return v;
}

export async function retryWithBackoff(fn, retries = 2, delay = 5000) {
  let attempt = 0;

  while (attempt < retries) {
    try {
      return await fn();
    } catch (err) {
      if (err.name === 'TimeoutError' && attempt < retries - 1) {
        console.warn(`⚠️ TimeoutError on attempt ${attempt + 1}. Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
        delay *= 2; // exponential backoff
        attempt++;
      } else {
        throw err;
      }
    }
  }
}