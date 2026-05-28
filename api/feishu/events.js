"use strict";

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function normalizeBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try {
    return JSON.parse(body);
  } catch (_) {
    return {};
  }
}

function verifyFeishuToken(payload) {
  const expected = process.env.FEISHU_VERIFICATION_TOKEN;
  if (!expected) return true;
  return payload && payload.token === expected;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  try {
    const payload = normalizeBody(req.body);

    if (payload.challenge) {
      if (!verifyFeishuToken(payload)) {
        sendJson(res, 403, { error: "invalid token" });
        return;
      }
      sendJson(res, 200, { challenge: payload.challenge });
      return;
    }

    if (!verifyFeishuToken(payload)) {
      sendJson(res, 403, { error: "invalid token" });
      return;
    }

    const { handleFeishuEvent } = require("../../src/feishu-qa-bot");
    const result = await handleFeishuEvent(payload);
    sendJson(res, 200, result);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "internal error" });
  }
};
