import assert from "node:assert/strict";
import { handleVerificationEmail } from "./_email_bundle.mjs";

const calls = [];
const env = {
  BACKEND_INTERNAL_TOKEN: "internal-token",
  EMAIL_FROM_ADDRESS: "verify@koinote.app",
  EMAIL_FROM_NAME: "Koinote",
  EMAIL: {
    async send(message) {
      calls.push(message);
      return { messageId: "test" };
    },
  },
};

function request(body, token = "internal-token") {
  return new Request("https://koinote.app/api/internal/email/verification", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-koinote-internal-token": token,
    },
    body: JSON.stringify(body),
  });
}

let response = await handleVerificationEmail(
  request({ email: "user@example.com", code: "123456", locale: "zh" }, "wrong"),
  env,
);
assert.equal(response.status, 401);
assert.equal(calls.length, 0);

response = await handleVerificationEmail(
  request({ email: "bad", code: "123456", locale: "zh" }),
  env,
);
assert.equal(response.status, 400);
assert.equal(calls.length, 0);

response = await handleVerificationEmail(
  request({ email: "user@example.com", code: "123456", locale: "zh" }),
  env,
);
assert.equal(response.status, 200);
assert.equal(calls.length, 1);
assert.equal(calls[0].to, "user@example.com");
assert.deepEqual(calls[0].from, {
  email: "verify@koinote.app",
  name: "Koinote",
});
assert.match(calls[0].subject, /Koinote/);
assert.match(calls[0].text, /123456/);
assert.match(calls[0].html, /123456/);

response = await handleVerificationEmail(
  request({
    email: "user@example.com",
    code: "654321",
    locale: "zh",
    purpose: "password_reset",
  }),
  env,
);
assert.equal(response.status, 200);
assert.equal(calls.length, 2);
assert.match(calls[1].subject, /重置/);
assert.match(calls[1].text, /654321/);

let retryCalls = 0;
const retryEnv = {
  ...env,
  EMAIL: {
    async send() {
      retryCalls += 1;
      if (retryCalls === 1) {
        const error = new Error("rate limited");
        error.code = "E_RATE_LIMIT_EXCEEDED";
        throw error;
      }
      return { messageId: "retry-ok" };
    },
  },
};
response = await handleVerificationEmail(
  request({ email: "retry@example.com", code: "654321", locale: "en" }),
  retryEnv,
);
assert.equal(response.status, 200);
assert.equal(retryCalls, 2);

console.log("email worker checks passed");
