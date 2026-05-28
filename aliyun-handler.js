"use strict";

const { handleFeishuEvent } = require("./src/feishu-qa-bot");

function headerValue(headers, name) {
  if (!headers) return "";
  const direct = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  return Array.isArray(direct) ? direct[0] : direct || "";
}

function sendJson(response, statusCode, data) {
  response.setStatusCode(statusCode);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.send(JSON.stringify(data));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseJsonBody(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function verifyFeishuToken(payload) {
  const expected = process.env.FEISHU_VERIFICATION_TOKEN;
  if (!expected || expected === "unused") return true;
  return payload && payload.token === expected;
}

exports.handler = async function handler(request, response) {
  try {
    const method = headerValue(request.headers, "x-fc-request-method") || request.method || "GET";
    const path = headerValue(request.headers, "x-fc-request-path") || request.path || "/";

    if (method === "GET" && path === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method !== "POST" || path !== "/feishu/events") {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    const payload = parseJsonBody(await readRequestBody(request));
    if (payload.challenge) {
      if (!verifyFeishuToken(payload)) {
        sendJson(response, 403, { error: "invalid token" });
        return;
      }
      sendJson(response, 200, { challenge: payload.challenge });
      return;
    }

    if (!verifyFeishuToken(payload)) {
      sendJson(response, 403, { error: "invalid token" });
      return;
    }

    const result = await handleFeishuEvent(payload);
    sendJson(response, 200, result);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "internal error" });
  }
};

exports.verifyFeishuToken = verifyFeishuToken;
