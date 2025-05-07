import dotenv from 'dotenv';
dotenv.config();

export function env(key, options: any| undefined = undefined) {
  const v = process.env[key];
  const helpText = options ? 'You can choose from these options: ' + options.join(', ') : '';
  if (!v) 
  {      
      throw new Error("Add this env variable to .env file: " + key + helpText);
  }

  if (options) {
    if (!options.includes(v)) {
      throw new Error(`This value is not supported: ${key}=${v}\r\n${helpText}`);
    }
  }

  return v;
}

export async function login(page) {
  console.log('🔐 Performing login...');

  await page.waitForSelector('#username, input[type="email"]', { timeout: 10000 });
  if (await page.locator('#username').count()) {
    await page.fill('#username', process.env.UNIFORM_USERNAME!);
  } else {
    await page.fill('input[type="email"]', process.env.UNIFORM_USERNAME!);
  }
  await page.click('button[type="submit"]');

  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  await page.fill('input[type="password"]', process.env.UNIFORM_PASSWORD!);
  await page.click('button[type="submit"]');

  await page.waitForNavigation({ timeout: 20000 });

  const url = page.url();

  console.log('Redirected to:', url); // For debugging, log the redirected URL
  console.log('✅ Login completed successfully.');
}