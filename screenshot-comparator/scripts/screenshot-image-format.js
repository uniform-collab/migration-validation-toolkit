/**
 * Playwright only outputs png/jpeg/webp. Set SCREENSHOT_FORMAT=bmp to write .bmp via Sharp
 * (use sharp(buf).toFile(pathEndingInBmp); Sharp infers BMP from the extension, not .bmp() / toFormat("bmp")).
 */
export function getScreenshotFileExtension() {
  const v = process.env.SCREENSHOT_FORMAT?.toLowerCase().trim();
  return v === "bmp" ? "bmp" : "png";
}
