"use strict";

const http = require("http");
const { handleFeishuEvent } = require("./src/feishu-qa-bot");

const PORT = Number(process.env.PORT || 3000);

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
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

async function handleWebhook(req, res) {
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

  const result = await handleFeishuEvent(payload);
  sendJson(res, 200, result);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/feishu/events") {
      await handleWebhook(req, res);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "internal error" });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Feishu QA bot listening on ${PORT}`);
  });
}

module.exports = { server, handleWebhook, readJson, verifyFeishuToken };
