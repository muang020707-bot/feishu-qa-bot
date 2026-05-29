"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { handler, verifyFeishuToken } = require("../aliyun-handler");

test("aliyun handler accepts callback token when no token is configured", () => {
  const old = process.env.FEISHU_VERIFICATION_TOKEN;
  delete process.env.FEISHU_VERIFICATION_TOKEN;
  assert.equal(verifyFeishuToken({ token: "anything" }), true);
  if (old !== undefined) process.env.FEISHU_VERIFICATION_TOKEN = old;
});

test("aliyun handler rejects callback token mismatch when configured", () => {
  const old = process.env.FEISHU_VERIFICATION_TOKEN;
  process.env.FEISHU_VERIFICATION_TOKEN = "expected";
  assert.equal(verifyFeishuToken({ token: "wrong" }), false);
  assert.equal(verifyFeishuToken({ token: "expected" }), true);
  if (old === undefined) delete process.env.FEISHU_VERIFICATION_TOKEN;
  else process.env.FEISHU_VERIFICATION_TOKEN = old;
});

test("aliyun http handler acknowledges message events immediately", async () => {
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    setStatusCode(statusCode) {
      this.statusCode = statusCode;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    send(body) {
      this.body = body;
    }
  };

  await handler(
    {
      method: "POST",
      path: "/feishu/events",
      body: JSON.stringify({
        event: {
          message: {
            message_id: "om_ack_test",
            content: JSON.stringify({ text: "hello" }),
            mentions: []
          }
        }
      })
    },
    response
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, accepted: true });
});
