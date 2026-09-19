import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { readSecret, SetupCancelled } from "../src/setup.js";

function terminal(raw = false) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: raw,
    setRawMode(value: boolean) {
      this.isRaw = value;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { input, output, text: () => text };
}

test("secret prompt accepts a paste without echo and restores terminal mode", async () => {
  for (const raw of [false, true]) {
    const tty = terminal(raw);
    try {
      const answer = readSecret("API key: ", tty.input, tty.output);
      tty.input.write("test-secret-never-echo\r");
      assert.equal(await answer, "test-secret-never-echo");
      assert.equal(tty.text(), "API key: \n");
      assert.equal(tty.input.isRaw, raw);
    } finally {
      tty.input.destroy();
      tty.output.destroy();
    }
  }
});

test("secret prompt abort, suspend, and EOF never reveal partial input", async () => {
  for (const ending of ["\u0003", "\u001a", "eof"]) {
    const tty = terminal();
    try {
      const answer = readSecret("API key: ", tty.input, tty.output);
      tty.input.write("partial-secret");
      if (ending === "eof") tty.input.end();
      else tty.input.write(ending);
      await assert.rejects(answer, SetupCancelled);
      assert.equal(tty.text(), "API key: \n");
      assert.equal(tty.input.isRaw, false);
    } finally {
      tty.input.destroy();
      tty.output.destroy();
    }
  }
});

test("secret prompt discards leftover paste while still raw", async () => {
  const tty = terminal();
  try {
    const answer = readSecret("API key: ", tty.input, tty.output);
    tty.input.write("first-secret\rsecond-secret\n");
    assert.equal(await answer, "first-secret");
    assert.equal(tty.input.read(), null);
    assert.equal(tty.text(), "API key: \n");
  } finally {
    tty.input.destroy();
    tty.output.destroy();
  }
});

test("secret prompt refuses noninteractive input before reading", async () => {
  const tty = terminal();
  tty.input.isTTY = false;
  try {
    await assert.rejects(readSecret("API key: ", tty.input, tty.output), /interactive terminal/);
    assert.equal(tty.text(), "");
    assert.equal(tty.input.isRaw, false);
  } finally {
    tty.input.destroy();
    tty.output.destroy();
  }
});
