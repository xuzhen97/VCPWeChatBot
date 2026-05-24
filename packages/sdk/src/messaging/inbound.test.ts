import test from "node:test";
import assert from "node:assert/strict";

import { weixinMessageToMsgContext } from "./inbound.js";

test("weixinMessageToMsgContext 会给图片上下文补具体 MIME", () => {
  const ctx = weixinMessageToMsgContext(
    {
      from_user_id: "user-1",
      create_time_ms: Date.now(),
      item_list: [],
    },
    "account-1",
    {
      decryptedPicPath: "C:/temp/car-photo.png",
      imageMediaType: "image/png",
    },
  );

  assert.equal(ctx.MediaType, "image/png");
});

test("weixinMessageToMsgContext 在缺少 imageMediaType 时按扩展名推断", () => {
  const ctx = weixinMessageToMsgContext(
    {
      from_user_id: "user-2",
      create_time_ms: Date.now(),
      item_list: [],
    },
    "account-2",
    {
      decryptedPicPath: "C:/temp/car-photo.jpeg",
    },
  );

  assert.equal(ctx.MediaType, "image/jpeg");
});