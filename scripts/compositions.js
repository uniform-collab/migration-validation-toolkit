import { CanvasClient } from '@uniformdev/canvas';
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

if (fs.existsSync('data/compositions.json')) {
  console.log('compositions.json exists, no need to download');
}
else
{
  const client = new CanvasClient({
    apiKey: env('UNIFORM_API_KEY'),
    projectId: env('UNIFORM_PROJECT_ID'),
  });

  
  const fetchVolume = 1000; // 1000 is max possible
  let result = await client.getCompositionList({ limit: fetchVolume, skipPatternResolution: true });

  let compositions = result.compositions;
  console.log('got ' + compositions.length + ' compositions from server');
  while (result.compositions.length === fetchVolume) {
    console.log('Checking if there are more on server with offset ' + compositions.length);
    result = await client.getCompositionList({
      limit: 1000, skipPatternResolution: true,
      offset: compositions.length
    });

    if (result.compositions.length > 0) {
      console.log('yep, got another '+ result.compositions.length);
      compositions = [...compositions, ...result.compositions]
    }
  }
    
  const data = compositions
    .filter(x => x.composition.type === "blogArticle") // filter only blog articles
    .map(x => ({ id: x.composition._id, name: x.composition._name }))
    .map(x => ({ id: x.id, name: x.name.replace(/\n/g, '') })) // trim name
    .map(x => x);
  
  try { 
    fs.mkdirSync('data', { recursive: true }); 
  } catch {}

  console.log('Saving compositions to compositions.json...');
  fs.writeFileSync('data/compositions.json', JSON.stringify(data, null, 2), 'utf-8');
  console.log('Saved.');
}