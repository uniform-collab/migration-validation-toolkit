import { chromium, expect, test as setup } from '@playwright/test';
import fs from 'fs';
import { env } from './utils';

setup('login', async ({ }) => {
    expect(fs.existsSync('data/entries.json'), 'no entries.json file, please run yarn test');

    const browser = await chromium.launchPersistentContext('./data/user-data', {
        headless: true,
    });
    
    const page = await browser.newPage();
    const entries = JSON.parse(fs.readFileSync('data/entries.json', 'utf-8'));
    const id = entries[0].id;
    const url = `https://uniform.app/projects/${env('UNIFORM_PROJECT_ID')}/dashboards/canvas/entries/${id}`;
    await page.goto(url);

    await page.waitForLoadState('load'); // Wait for network to be idle

    console.log('Waiting for Save button to load...');
    try {
        await page.locator('button[data-testid="multioptions-button-main"][data-test-role="header-button"]').waitFor({ timeout: 10000, });
        console.log('Cookies worked well!');
        await browser.close();
        return;
    }                
    catch(ex) {     
        console.error(ex.message);
    }
    
    // Wait for the redirection to complete (ensure you're on the login page)
    await page.waitForLoadState('load'); // Wait for network to be idle
    console.log('url:' + page.url()); // For debugging, log the redirected URL
    
    // Perform login
    await page.fill('#username', env('UNIFORM_USERNAME'));
    await page.click('button[type="submit"]');

    await page.waitForLoadState('load'); // Wait for network to be idle
    console.log('Redirected to:', page.url()); // For debugging, log the redirected URL

    await page.fill('#password', env('UNIFORM_PASSWORD'));
    
    try {
        await page.click('button[type="submit"]');
  
        // Wait for navigation or some indicator of successful login
        // await page.waitForURL('https://example.com/dashboard');
        
        await page.waitForLoadState('load'); // Wait for network to be idle
        console.log('Redirected to:', page.url()); // For debugging, log the redirected URL

        await page.locator('button[data-testid="multioptions-button-main"]').waitFor({ timeout: 10000, });
        console.log('Cookies worked well!');
    } catch (err: any) {
        console.log('Failed to log in, screenshot saved to D:/tests')
        page.screenshot({path: 'data/login.png', fullPage: true, type: 'png'});
        expect(false).toBeTruthy();
        return;
    }

    // Save cookies to a file
    //await page.context().storageState({ path: storageStateFile });
    console.log('Cookies were saved');
  
    //await context.close();
    await browser.close();
  });  