import readline from "node:readline";

// Non-TTY stdin (pipes, heredocs): one shared readline so consecutive prompts do not lose
// buffered lines when an interface is closed.
let lines = null;
function nextLine() {
  if (!lines) {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    lines = { queue: [], waiters: [], closed: false };
    rl.on("line", (l) => (lines.waiters.length ? lines.waiters.shift()(l) : lines.queue.push(l)));
    rl.on("close", () => { lines.closed = true; while (lines.waiters.length) lines.waiters.shift()(""); });
  }
  if (lines.queue.length) return Promise.resolve(lines.queue.shift());
  if (lines.closed) return Promise.resolve("");
  return new Promise((resolve) => lines.waiters.push(resolve));
}

// TTY stdin: raw mode, so hidden input works and no readline state lingers between prompts.
function readTty(question, { hidden }) {
  const input = process.stdin, output = process.stdout;
  return new Promise((resolve, reject) => {
    output.write(question);
    let buf = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = (err) => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      err ? reject(err) : resolve(buf.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length) { buf = buf.slice(0, -1); if (!hidden) output.write("\b \b"); }
          continue;
        }
        if (ch >= " ") { buf += ch; if (!hidden) output.write(ch); }
      }
    };
    input.on("data", onData);
  });
}

/** Read one line from stdin. With `hidden`, characters are not echoed on a terminal. */
export async function ask(question, { hidden = false } = {}) {
  if (process.stdin.isTTY) return readTty(question, { hidden });
  process.stdout.write(question);
  const line = await nextLine();
  process.stdout.write("\n");
  return line.trim();
}
