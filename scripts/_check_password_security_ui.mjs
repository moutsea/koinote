import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const login = read("spa/src/pages/LoginPage.tsx");
const dashboard = read("spa/src/pages/DashboardPage.tsx");
const security = read("spa/src/components/PasswordSecurityCard.tsx");
const accountDeletion = read("spa/src/components/AccountDeletionCard.tsx");
const editor = read("spa/src/pages/EditorPage.tsx");
const api = read("spa/src/api.ts");

assert.match(login, /sendPasswordResetCode/);
assert.match(login, /resetPassword/);
assert.match(login, /t\.auth\.forgotPassword/);
assert.match(login, /isPasswordReset/);
assert.match(api, /\/api\/auth\/password-reset-code/);
assert.match(api, /\/api\/auth\/password-reset/);

assert.match(dashboard, /<PasswordSecurityCard user=\{user\}/);
assert.match(security, /changePassword/);
assert.match(security, /invalidateOtherSessions/);
assert.match(security, /user\.hasPassword/);
assert.match(dashboard, /<AccountDeletionCard user=\{user\}/);
assert.match(accountDeletion, /deleteAccount/);
assert.match(accountDeletion, /account_deletion_payment_pending/);
assert.match(accountDeletion, /confirmation\.trim\(\)\.toLowerCase\(\)/);
assert.match(accountDeletion, /interpolate\(t\.accountDeletion\.confirmLabel, \{ email: user\.email \}\)/);
assert.doesNotMatch(accountDeletion, /confirmLabel\.replace/);
assert.match(api, /DELETE[\s\S]*?\/api\/account|\/api\/account[\s\S]*?method: "DELETE"/);
assert.match(api, /clearDesktopOfflineAccount/);
assert.match(api, /clearDesktopSession/);

assert.match(editor, /mobileDocsOpen/);
assert.match(editor, /role="dialog"/);
assert.match(editor, /aria-modal="true"/);
assert.match(editor, /document\.body\.style\.overflow = "hidden"/);
assert.match(editor, /event\.key === "Escape"/);
assert.match(editor, /className="fixed inset-0 z-50 lg:hidden"/);
assert.match(editor, /setMobileDocsOpen\(false\);\s*handleSelect\(docId\)/);

console.log("password security and mobile drawer checks passed");
