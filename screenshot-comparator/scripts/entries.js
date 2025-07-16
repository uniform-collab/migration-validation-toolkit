import { ContentClient } from '@uniformdev/canvas';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

function env(key) {
  const v = process.env[key];
  if (!v) 
  {
      throw new Error("Add this env variable to .env file: " + key);
  }
  
  return v;
}

if (fs.existsSync('data/entries.json')) {
  console.log('entries.json exists, no need to download');
}
else
{
  const client = new ContentClient({
    apiKey: env('UNIFORM_API_KEY'),
    projectId: env('UNIFORM_PROJECT_ID'),
  });

  
  const fetchVolume = 50; // 50 is max possible
  let result = await client.getEntries({ limit: fetchVolume, skipPatternResolution: true });

  let entries = result.entries;
  console.log('got ' + entries.length + ' entries from server');
  while (result.entries.length === fetchVolume) {
    console.log('Checking if there are more on server with offset ' + entries.length);
    result = await client.getEntries({
      limit: fetchVolume, skipPatternResolution: true,
      offset: entries.length
    });

    if (result.entries.length > 0) {
      console.log('yep, got another '+ result.entries.length);
      entries = [...entries, ...result.entries]
    }
  }
    
  console.log('Saving entries to entries.json');
  try { fs.mkdirSync('data', { recursive: true }); } catch {}
  fs.writeFileSync('data/entries.json', JSON.stringify(entries.map(x => ({ id: x.entry._id, name: x.entry._name.replace(/\n/g, ''), type: x.entry.type, slug: x.entry._slug, productTitle: x.entry.fields.productTitle?.value })), null, 2), 'utf-8');
  console.log('Saving completed');
}