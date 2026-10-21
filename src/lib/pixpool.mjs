/**
 * compareImages (pixdiff.mjs) on worker threads. pixelmatch is synchronous JavaScript, so one process
 * compares one pair at a time on its main thread: a 4,000-page report (~100k pairs) used ~1 core of
 * 30 for most of its run. `createPixPool(n)` runs n workers, each with its own copy of pixdiff.mjs;
 * `run(prod, mig, diff)` resolves with what compareImages returns, or rejects with its error message.
 * n <= 1 returns null: the caller compares in-process, exactly as before.
 */
import { Worker } from "node:worker_threads";

export function createPixPool(n) {
  if (!(n > 1)) return null;
  const url = new URL("./pixworker.mjs", import.meta.url);
  const idle = [];
  const queue = [];
  const workers = [];
  let seq = 0;
  let broken = null;

  const pump = () => {
    while (idle.length && queue.length) {
      const w = idle.pop();
      const job = queue.shift();
      w.job = job;
      w.postMessage({ id: job.id, args: job.args });
    }
  };
  for (let i = 0; i < n; i++) {
    const w = new Worker(url);
    w.on("message", ({ ok, result, error }) => {
      const job = w.job;
      w.job = null;
      idle.push(w);
      pump();
      if (ok) job.resolve(result);
      else job.reject(new Error(error));
    });
    w.on("error", (err) => {
      broken = err;
      w.job?.reject(err);
      for (const job of queue.splice(0)) job.reject(err);
    });
    idle.push(w);
    workers.push(w);
  }
  return {
    size: n,
    run(...args) {
      if (broken) return Promise.reject(broken);
      return new Promise((resolve, reject) => {
        queue.push({ id: ++seq, args, resolve, reject });
        pump();
      });
    },
    close() {
      return Promise.all(workers.map((w) => w.terminate()));
    },
  };
}
