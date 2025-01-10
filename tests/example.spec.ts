import { chromium, test, expect } from '@playwright/test';
import fs from 'fs';

import dotenv from 'dotenv';
dotenv.config();

function env(key, options) {
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

console.log('Reading compositions from compositions.json');
const compositions = JSON.parse(fs.readFileSync('data/compositions.json', 'utf-8'));
//const compositions=[{composition: { _id: 'ed542bc8-be57-4a39-8a1f-5d714257e2fc', _name: 'alen'} }]
const ids = compositions.map(x => x.id);
const names = compositions.map(x => x.name);

const mode = env('ERROR_TYPES', ['errors', 'warnings', 'all']);

let browser;

test.beforeAll(async () => {
  if (!fs.existsSync('data/screenshots')) {
    fs.mkdirSync('data/screenshots');
  }
  browser = await chromium.launchPersistentContext('./data/user-data', {
    headless: true,
  });

});

test.afterAll(async () => {
  await browser.close();
});

const count = ids.length;

const testPrefix = 'Check composition #';
for (var i = 0; i < count; ++i) {
  test(`${testPrefix}${i}: ${names[i]}, ${ids[i]}`, async () => {
    const title = test.info().title.substring(testPrefix.length);
    const match = title.match(/\: (.+)\, (.+)/);
    if (!match) throw new Error("regex");

    const id = match[2];
    const name = match[1];

    const page = await browser.newPage();


    try {

      await page.goto(`https://uniform.app/projects/${env('UNIFORM_PROJECT_ID')}/dashboards/canvas/edit/${id}`);
      await page.waitForLoadState('load'); // Wait for network to be idle

      console.log('Waiting for Save button to load...');
      await page.locator('button[data-testid="multioptions-button-main"]').waitFor({ timeout: 30000 });

      try {
        await page.locator('button[data-testid="composition-validation-error"]').waitFor({ timeout: 30000 });
      }
      catch (exx) {
        console.log('validator did not appear after 30s');
      }

      await new Promise(r => setTimeout(r, 10000));

      // Locate the button with the specified data-testid
      const button = page.locator('button[data-testid="composition-validation-error"]');

      // Assert that the button exists
      if (await button.count() > 0) {
        const color = await button.evaluate(node => node.ownerDocument.defaultView.getComputedStyle(node).color);
        
        const type = color === 'rgb(250, 204, 21)' ? 'warning' : (color === 'rgb(217, 83, 79)' ? 'error' : 'unknown');
        if (type === 'unknown') throw new Error('Unexpected color: ' + color);

        let check = false;

        if (type === 'error') if (mode === 'errors' || mode === 'all') 
          check = true;

        if (type === 'warning') if (mode === 'warnings' || mode === 'all') 
          check = true;

        if (!check) 
          return;                

        // Extract the digit after </svg>
        const digit = await button.evaluate(node => {
          // Use innerHTML to access raw HTML content of the button
          const htmlContent = node.innerHTML;

          // Match the digit literal after </svg>, allowing spaces and line breaks
          const match = htmlContent.match(/\d+/g);
          if (!match || match.length === 0) {
            throw new Error("Failed to find any number in composition-validation-error button, html: " + htmlContent);
          }

          return parseInt(match[match.length-1], 10); // Convert the captured digit to a number
        });

        // Assert that the digit is not greater than 0
        expect(digit, `Test failed: There are ${digit} errors on ${name} composition.`).toBeLessThanOrEqual(0);
      } else {
        console.log('Button with data-testid="composition-validation-error" not found.');
      }
    } finally {
      const screenshot = await page.screenshot({ path: 'data/screenshots/' + id + '.png', type: 'png' })
      test.info().attach('screenshot', { body: screenshot, contentType: 'image/png' });        
    }
  });
} 