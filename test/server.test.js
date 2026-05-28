"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyFeishuToken } = require("../server");

test("accepts callback token when no token is configured", () => {
  const old = process.env.FEISHU_VERIFICATION_TOKEN;
  delete process.env.FEISHU_VERIFICATION_TOKEN;
  assert.equal(verifyFeishuToken({ token: "anything" }), true);
  if (old !== undefined) process.env.FEISHU_VERIFICATION_TOKEN = old;
});

test("rejects callback token mismatch when configured", () => {
  const old = process.env.FEISHU_VERIFICATION_TOKEN;
  process.env.FEISHU_VERIFICATION_TOKEN = "expected";
  assert.equal(verifyFeishuToken({ token: "wrong" }), false);
  assert.equal(verifyFeishuToken({ token: "expected" }), true);
  if (old === undefined) delete process.env.FEISHU_VERIFICATION_TOKEN;
  else process.env.FEISHU_VERIFICATION_TOKEN = old;
});
