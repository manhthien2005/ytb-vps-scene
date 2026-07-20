// @vitest-environment node
import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

describe("secret redaction", () => {
  it("recursively removes session URIs and token-like fields case-insensitively", () => {
    expect(redactSecrets({
      Authorization: "Bearer credential-value",
      nested: {
        SESSION_URI: "https://www.googleapis.com/upload/drive/v3/files?upload_id=capability",
        RefreshToken: "refresh-value",
      },
    })).toEqual({
      Authorization: "[REDACTED]",
      nested: { SESSION_URI: "[REDACTED]", RefreshToken: "[REDACTED]" },
    });
  });

  it.each([
    "prefix bEaReR credential-value suffix",
    "HTTPS://WWW.GOOGLEAPIS.COM/UPLOAD/drive/v3/files",
    "ordinary prefix UPLOAD_ID=capability",
    "https://example.test/callback?CoDe=credential-value",
    "access_TOKEN=credential-value",
    "client_SECRET=credential-value",
    '{"refresh_TOKEN":"credential-value"}',
    "Bearer",
    "refreshToken=credential-value",
    "code_verifier=credential-value",
  ])("redacts a sensitive string value before truncation", (value) => {
    expect(redactSecrets(`${"x".repeat(600)}${value}`)).toBe("[REDACTED]");
  });

  it("truncates only non-sensitive strings to 512 characters", () => {
    expect(redactSecrets("x".repeat(600))).toBe("x".repeat(512));
  });

  it("handles cycles, excessive depth, accessors, and unsupported values safely", () => {
    const circular: Record<string, unknown> = { safe: "value" };
    circular.self = circular;
    let getterCalls = 0;
    Object.defineProperty(circular, "danger", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "credential-value";
      },
    });
    let deep: Record<string, unknown> = { leaf: "value" };
    for (let index = 0; index < 9; index += 1) deep = { nested: deep };

    expect(redactSecrets({ circular, deep, unsupported: () => undefined })).toEqual({
      circular: {
        safe: "value",
        self: "[UNSERIALIZABLE]",
        danger: "[UNSERIALIZABLE]",
      },
      deep: {
        nested: {
          nested: {
            nested: {
              nested: {
                nested: {
                  nested: {
                    nested: "[UNSERIALIZABLE]",
                  },
                },
              },
            },
          },
        },
      },
      unsupported: "[UNSERIALIZABLE]",
    });
    expect(getterCalls).toBe(0);
  });

  it("copies arrays without invoking indexed getters", () => {
    const values = ["safe", "value"];
    let getterCalls = 0;
    Object.defineProperty(values, 1, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "Bearer credential-value";
      },
    });

    expect(redactSecrets(values)).toEqual(["safe", "[UNSERIALIZABLE]"]);
    expect(getterCalls).toBe(0);
  });

  it("copies an own __proto__ key without mutating the output prototype", () => {
    const input = JSON.parse('{"__proto__":{"safe":"value"}}') as Record<string, unknown>;
    const output = redactSecrets(input) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(output, "__proto__")).toBe(true);
    expect(output.__proto__).toEqual({ safe: "value" });
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  });

  it.each([
    "email",
    "EMAIL_ADDRESS",
    "account-email",
  ])("redacts an email identity under the %s key", (key) => {
    expect(redactSecrets({ [key]: "admin@example.test" })).toEqual({
      [key]: "[REDACTED]",
    });
  });

  it("redacts a complete email address in text but preserves an already-masked hint", () => {
    expect(redactSecrets({ detail: "Account admin@example.test is connected" })).toEqual({
      detail: "[REDACTED]",
    });
    expect(redactSecrets({ emailHint: "a***@example.test" })).toEqual({
      emailHint: "a***@example.test",
    });
  });

  it.each([
    "providerBody",
    "raw_provider_body",
    "PROVIDER-RESPONSE",
    "providerResponseBody",
    "response_body",
  ])("redacts arbitrary provider content under the %s key", (key) => {
    expect(redactSecrets({ [key]: "arbitrary upstream response text" })).toEqual({
      [key]: "[REDACTED]",
    });
  });

  it.each([
    '{"uploadId":"capability-value"}',
    '{"UPLOAD_ID":"capability-value"}',
    "prefix upload-id=capability-value suffix",
  ])("redacts an embedded upload capability representation", (value) => {
    expect(redactSecrets({ detail: value })).toEqual({ detail: "[REDACTED]" });
  });

  it.each([
    "rawProviderResponse",
    "RAW_PROVIDER_RESPONSE",
    "rawResponseBody",
    "raw-response-body",
    "providerErrorBody",
    "PROVIDER_ERROR_BODY",
    "upstreamResponsePayload",
    "upstream-response-payload",
    "googleApiResponse",
    "GOOGLE_API_RESPONSE",
    "driveErrorResponse",
    "drive_error_response",
  ])("compositionally redacts provider content under the %s key", (key) => {
    expect(redactSecrets({ [key]: "arbitrary upstream response text" })).toEqual({
      [key]: "[REDACTED]",
    });
  });
});
