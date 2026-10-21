// One worker of pixpool.mjs: runs compareImages for the main thread, one pair at a time.
import { parentPort } from "node:worker_threads";
import { compareImages } from "./pixdiff.mjs";

parentPort.on("message", async ({ id, args }) => {
  try {
    parentPort.postMessage({ id, ok: true, result: await compareImages(...args) });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
});
