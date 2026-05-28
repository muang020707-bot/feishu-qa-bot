"use strict";

const { handleFeishuEvent } = require("./src/feishu-qa-bot");

function headerValue(headers, name) {
  if (!headers) return "";
  const direct = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  return Array.isArray(direct) ? direct[0] : direct || "";
}

function sendJson(response, statusCode, data) {
  if (!response || typeof response.setStatusCode !== "function") {
    return {
      statusCode,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(data)
    };
  }
  response.setStatusCode(statusCode);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.send(JSON.stringify(data));
  return undefined;
}

function readRequestBody(request) {
  if (request && request.body !== undefined) {
    return Promise.resolve(Buffer.isBuffer(request.body) ? request.body.toString("utf8") : String(request.body || ""));
  }
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

function parseHttpEvent(event) {
  const raw = Buffer.isBuffer(event) ? event.toString("utf8") : event;
  const parsed = typeof raw === "string" ? parseJsonBody(raw) : raw || {};
  return {
    method: parsed.httpMethod || parsed.requestContext && parsed.requestContext.httpMethod || "GET",
    path: parsed.path || parsed.rawPath || parsed.requestContext && parsed.requestContext.path || "/",
    body: parsed.isBase64Encoded ? Buffer.from(parsed.body || "", "base64").toString("utf8") : parsed.body || ""
  };
}

function verifyFeishuToken(payload) {
  const expected = process.env.FEISHU_VERIFICATION_TOKEN;
  if (!expected || expected === "unused") return true;
  return payload && payload.token === expected;
}

exports.handler = async function handler(request, response) {
  try {
    const eventMode = !response || typeof response.setStatusCode !== "function";
    const httpEvent = eventMode ? parseHttpEvent(request) : null;
    const method = eventMode
      ? httpEvent.method
      : headerValue(request.headers, "x-fc-request-method") || request.method || "GET";
    const path = eventMode
      ? httpEvent.path
      : headerValue(request.headers, "x-fc-request-path") || request.path || "/";

    if (method === "GET" && path === "/health") {
      return sendJson(response, 200, { ok: true });
    }

    if (method !== "POST" || path !== "/feishu/events") {
      return sendJson(response, 404, { error: "not found" });
    }

    const payload = parseJsonBody(eventMode ? httpEvent.body : await readRequestBody(request));
    if (payload.challenge) {
      if (!verifyFeishuToken(payload)) {
        return sendJson(response, 403, { error: "invalid token" });
      }
      return sendJson(response, 200, { challenge: payload.challenge });
    }

    if (!verifyFeishuToken(payload)) {
      return sendJson(response, 403, { error: "invalid token" });
    }

    const result = await handleFeishuEvent(payload);
    return sendJson(response, 200, result);
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: "internal error" });
  }
};

exports.verifyFeishuToken = verifyFeishuToken;
