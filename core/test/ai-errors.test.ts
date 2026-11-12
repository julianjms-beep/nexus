import test from "node:test";
import assert from "node:assert/strict";
import { describeAiError, whyFromError } from "../src/ai-errors.ts";

test("every AI failure gets a plain title, who is at fault and what to do", () => {
  assert.equal(describeAiError("no_key").fix, "settings-ai");
  assert.match(describeAiError("no_key").text, /Ajustes → NEXUS AI/);
  assert.equal(describeAiError("auth").title, "Claude no acepta la clave");
  assert.equal(describeAiError("rate_limit", "Your credit balance is too low").why, "credits");
  assert.equal(describeAiError("rate_limit").fix, "wait");
  assert.equal(describeAiError("api_529").why, "overloaded");
  assert.match(describeAiError("overloaded").text, /No es cosa tuya/);
  assert.equal(describeAiError("offline").fix, "network");
  assert.equal(describeAiError("api_503").why, "api_5xx");
  assert.equal(describeAiError("api_413").why, "too_long");
  assert.equal(describeAiError("engine_down").fix, "wait");
  assert.equal(describeAiError("refusal").mine, true);
  assert.equal(describeAiError("").fix, "retry");
  for (const w of ["no_key", "auth", "rate_limit", "offline", "timeout", "engine_down", "api_400", "api_500", "zzz"]) {
    const d = describeAiError(w); assert.ok(d.title.length > 5 && d.text.length > 20 && !/undefined/.test(d.text));
  }
});

test("the SDK's errors map to short codes", () => {
  assert.equal(whyFromError(new Error("x"), true, false, false), "auth");
  assert.equal(whyFromError(new Error("x"), false, true, false), "rate_limit");
  assert.equal(whyFromError(new Error("Connection timed out"), false, false, true), "timeout");
  assert.equal(whyFromError(new Error("ECONNREFUSED"), false, false, true), "offline");
  assert.equal(whyFromError(new Error("x"), false, false, false, 529), "overloaded");
  assert.equal(whyFromError(new Error("x"), false, false, false, 500), "api_500");
  assert.equal(whyFromError(new Error("x"), false, false, false), "error");
});
