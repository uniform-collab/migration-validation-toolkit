import fs from "fs";
import path from "path";

const DEFAULT_RELATIVE = "selector-maps/default.json";

/**
 * @typedef {object} SelectorMapItems
 * @property {"directChildren" | "querySelectorAll"} strategy
 * @property {string} [selector] - required when strategy is querySelectorAll
 */

/**
 * @typedef {object} SelectorMap
 * @property {string[]} scopeSelectors - CSS selectors tried in order (document.querySelector); first match is the capture root
 * @property {SelectorMapItems} items
 */

/**
 * Load selector map from SELECTOR_MAP_PATH (relative to cwd or absolute), or selector-maps/default.json.
 * @returns {SelectorMap}
 */
export function loadSelectorMap() {
  const raw = process.env.SELECTOR_MAP_PATH?.trim();
  const base = process.cwd();
  const filePath = raw
    ? path.isAbsolute(raw)
      ? raw
      : path.join(base, raw)
    : path.join(base, DEFAULT_RELATIVE);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Selector map not found: ${filePath}. Set SELECTOR_MAP_PATH or add ${DEFAULT_RELATIVE} under the project root.`
    );
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new Error(`Invalid selector map JSON (${filePath}): ${e.message}`);
  }

  validateSelectorMap(data, filePath);
  return data;
}

/**
 * @param {unknown} data
 * @param {string} filePath
 */
function validateSelectorMap(data, filePath) {
  if (!data || typeof data !== "object") {
    throw new Error(`Selector map must be an object (${filePath})`);
  }
  const scopeSelectors = data.scopeSelectors;
  if (!Array.isArray(scopeSelectors) || scopeSelectors.length === 0) {
    throw new Error(
      `Selector map must include a non-empty scopeSelectors array (${filePath})`
    );
  }
  for (const s of scopeSelectors) {
    if (typeof s !== "string" || !s.trim()) {
      throw new Error(
        `scopeSelectors must be non-empty strings (${filePath})`
      );
    }
  }
  const items = data.items;
  if (!items || typeof items !== "object") {
    throw new Error(`Selector map must include items object (${filePath})`);
  }
  const strategy = items.strategy;
  if (strategy !== "directChildren" && strategy !== "querySelectorAll") {
    throw new Error(
      `items.strategy must be "directChildren" or "querySelectorAll" (${filePath})`
    );
  }
  if (strategy === "querySelectorAll") {
    if (typeof items.selector !== "string" || !items.selector.trim()) {
      throw new Error(
        `items.selector is required when strategy is querySelectorAll (${filePath})`
      );
    }
  }
}
