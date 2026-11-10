import assert from "node:assert/strict";
import { build, stop } from "esbuild";

const originalFetch = globalThis.fetch;
try {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      export { ApiError } from "./spa/src/api";
      export { githubImportErrorMessage, importGitHubAgentRepository } from "./spa/src/agentGitHubImport";
      export { agentWorkspace, agentWorkspaceZh, agentWorkspaceFr, agentWorkspaceJa } from "./spa/src/i18n/agentWorkspace";
    ` }, bundle: true, write: false, format: "esm", platform: "node",
  });
  const { ApiError, githubImportErrorMessage, importGitHubAgentRepository, agentWorkspace, agentWorkspaceZh, agentWorkspaceFr, agentWorkspaceJa } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const locales = { en: agentWorkspace, zh: agentWorkspaceZh, fr: agentWorkspaceFr, ja: agentWorkspaceJa };
  const input = { repositoryUrl: "https://github.com/example/skills", ref: "main", requestId: "github-import-regression" };
  let requests = 0;
  globalThis.fetch = async (path, init) => {
    requests++;
    assert.equal(path, "/api/agent/workspaces/import/github");
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "include");
    assert.deepEqual(JSON.parse(init.body), input);
    return new Response(JSON.stringify({ code: "github_temporarily_unavailable", error: "Upstream connection failed" }), { status: 503 });
  };
  // Exercise the real HTTP response parser and ApiError identity used by the import helper.
  let temporaryError;
  await assert.rejects(importGitHubAgentRepository(input), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "github_temporarily_unavailable");
    temporaryError = error;
    return true;
  });
  assert.equal(requests, 1, "temporary import failures are returned without an automatic retry");

  const existingMappings = [
    ["github_token_required", "githubTokenRequired"], ["github_token_invalid", "githubTokenInvalid"],
    ["github_credential_unavailable", "githubCredentialUnavailable"], ["github_repository_invalid", "githubRepositoryInvalid"],
    ["github_repository_unavailable", "githubRepositoryUnavailable"], ["github_archive_invalid", "githubArchiveInvalid"],
    ["github_rate_limited", "githubRateLimited"], ["rate_limited", "githubRateLimited"],
    ["sensitive_data_detected", "githubSensitive"], ["agent_workspace_quota_exceeded", "githubQuota"],
    ["revision_conflict", "sharingConflict"],
    ["license_changed", "githubLicenseChanged"], ["license_review_required", "githubLicenseReviewRequired"],
    ["publication_license_mismatch", "githubPublicationLicenseMismatch"],
    ["repository_identity_mismatch", "githubRepositoryIdentityMismatch"],
  ];
  for (const [locale, labels] of Object.entries(locales)) {
    const message = githubImportErrorMessage(temporaryError, labels);
    assert.equal(typeof message, "string", `${locale} has a temporary-unavailability message`);
    assert.ok(message.trim(), `${locale} temporary-unavailability message is not empty`);
    assert.equal(message, labels.githubTemporarilyUnavailable, `${locale} uses the dedicated mapping`);
    for (const key of ["githubImportFailed", "githubRepositoryUnavailable", "githubTokenRequired", "githubRateLimited"]) {
      assert.notEqual(message, labels[key], `${locale} temporary unavailability differs from ${key}`);
    }
    if (locale !== "en") assert.notEqual(message, agentWorkspace.githubTemporarilyUnavailable, `${locale} has its own translation`);
    for (const [code, key] of existingMappings) {
      assert.equal(githubImportErrorMessage(new ApiError(503, "Import failed", code), labels), labels[key], `${locale} preserves ${code}`);
    }
    for (const error of [new ApiError(503, "Unknown upstream error", "unknown_error"), new ApiError(503, "Missing code"), new Error("Network unavailable"), { code: "github_temporarily_unavailable" }, null]) {
      assert.equal(githubImportErrorMessage(error, labels), labels.githubImportFailed, `${locale} preserves the generic fallback`);
    }
  }
  console.log("GitHub import HTTP 503, dedicated temporary-unavailability translations, existing mappings and fallback checks passed");
} finally {
  globalThis.fetch = originalFetch;
  stop();
}
