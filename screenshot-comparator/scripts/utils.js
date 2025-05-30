export function env(key) {
  const v = process.env[key];
  if (!v) 
  {
      throw new Error("🆘 Add this env variable to .env file: " + key);
  }
  return v;
}