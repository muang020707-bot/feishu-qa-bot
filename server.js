"use strict";

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function verifyFeishuToken(payload) {
  const expected = process.env.FEISHU_VERIFICATION_TOKEN;
  if (!expected) return true;
  return payload && payload.token === expected;
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/feishu/events") {
      const payload = await readJson(req);

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

      const { handleFeishuEvent } = require("./src/feishu-qa-bot");
      const result = await handleFeishuEvent(payload);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "internal error" });
  }
};

module.exports.verifyFeishuToken = verifyFeishuToken;
