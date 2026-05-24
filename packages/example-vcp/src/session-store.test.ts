import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { SessionStore } from "./session-store.js";

test("buildRequestMessages 会把 image/* 归一成具体图片 MIME", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "example-vcp-session-store-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const imagePath = path.join(tempDir, "car-photo.jpg");
  await writeFile(imagePath, Buffer.from("fake-jpeg-binary"));

  const store = new SessionStore({
    maxTurns: 4,
    maxChars: 4000,
  });

  const messages = await store.buildRequestMessages({
    conversationId: "conv-1",
    text: "这是什么车",
    media: {
      type: "image",
      filePath: imagePath,
      mimeType: "image/*",
    },
  });

  assert.equal(messages.length, 1);
  const currentMessage = messages[0];
  assert.equal(currentMessage.role, "user");
  assert.ok(Array.isArray(currentMessage.content));

  const imagePart = currentMessage.content.find((part) => part.type === "image_url");
  assert.ok(imagePart);
  assert.match(imagePart.image_url.url, /^data:image\/jpeg;base64,/);
  assert.doesNotMatch(imagePart.image_url.url, /^data:image\/\*;base64,/);
});

test("buildRequestMessages 会根据文件扩展名补具体图片 MIME", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "example-vcp-session-store-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const imagePath = path.join(tempDir, "dashboard.png");
  await writeFile(imagePath, Buffer.from("fake-png-binary"));

  const store = new SessionStore({
    maxTurns: 4,
    maxChars: 4000,
  });

  const messages = await store.buildRequestMessages({
    conversationId: "conv-2",
    text: "帮我看看图里是什么",
    media: {
      type: "image",
      filePath: imagePath,
      mimeType: "application/octet-stream",
    },
  });

  const currentMessage = messages[0];
  assert.ok(Array.isArray(currentMessage.content));

  const imagePart = currentMessage.content.find((part) => part.type === "image_url");
  assert.ok(imagePart);
  assert.match(imagePart.image_url.url, /^data:image\/png;base64,/);
});