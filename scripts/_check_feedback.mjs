import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const migration = read("backend/migrations/0037_feedback.sql");
assert.match(migration, /CREATE TABLE IF NOT EXISTS user_feedback/);
assert.match(migration, /REFERENCES users\(id\) ON DELETE SET NULL/);
assert.match(migration, /category IN \('bug', 'experience'\)/);
assert.match(migration, /char_length\(btrim\(message\)\) BETWEEN 1 AND 4000/);
assert.match(migration, /user_feedback_created_idx/);

const redactionMigration = read(
  "backend/migrations/0038_feedback_page_path_redaction.sql",
);
assert.match(redactionMigration, /SET page_path = '\/share\/:token'/);
assert.match(redactionMigration, /WHERE page_path LIKE '\/share\/%'/);

const routes = read("backend/internal/server/server.go");
assert.match(routes, /POST \/api\/feedback", a\.feedbackCreate/);
assert.match(routes, /GET \/api\/admin\/feedback", a\.adminFeedbackList/);

const backend = read("backend/internal/server/feedback.go");
assert.match(backend, /func \(a \*App\) feedbackCreate/);
assert.match(backend, /a\.requireUser\(w, r\)/);
assert.match(backend, /feedback-submit:user:/);
assert.match(backend, /feedbackMessageMax\s*= 4000/);
assert.match(backend, /errFeedbackMessageInvalid/);
assert.match(backend, /func feedbackMessageHasForbiddenRune/);
assert.match(backend, /func feedbackPagePathHasForbiddenRune/);
assert.match(backend, /unicode\.IsControl\(character\)/);
assert.match(backend, /func feedbackRequestClient/);
assert.match(backend, /func sanitizeFeedbackPagePath/);
assert.match(backend, /"\/share\/:token"/);
assert.match(
  backend,
  /item\.PagePath = sanitizeFeedbackPagePath\(item\.PagePath\)/,
);
assert.match(
  backend,
  /strings\.HasPrefix\(bearerToken\(r\), desktopAccessTokenPrefix\)/,
);
assert.match(backend, /func \(a \*App\) adminFeedbackList/);
assert.match(backend, /a\.requireAdmin\(w, r\)/);
assert.ok(
  backend.indexOf("input, err := normalizeFeedbackInput(input)") <
    backend.indexOf('fmt.Sprintf("feedback-submit:user:%d", user.ID)'),
  "invalid feedback must be rejected before consuming rate-limit quota",
);
assert.match(backend, /func parseFeedbackListParams/);
assert.match(backend, /WHERE \(\$1::bigint = 0 OR feedback\.id < \$1\)/);
assert.match(backend, /ORDER BY feedback\.id DESC/);
assert.match(backend, /"nextCursor": nextCursor/);

const desktopAuth = read("backend/internal/server/desktop_auth.go");
assert.match(
  desktopAuth,
  /case "\/api\/feedback":\s*return method == http\.MethodPost/,
);
assert.match(desktopAuth, /"\/api\/admin\/feedback"/);

const api = read("spa/src/api.ts");
assert.match(api, /export type FeedbackCategory = "bug" \| "experience"/);
assert.match(api, /export function submitFeedback/);
assert.match(api, /export function getAdminFeedback/);

const appShell = read("spa/src/components/AppShell.tsx");
assert.match(appShell, /onShowFeedback=\{\(\) => setFeedbackOpen\(true\)\}/);
assert.match(appShell, /!localMode && feedbackOpen/);
assert.match(appShell, /<FeedbackDialog/);
assert.match(appShell, /t\.feedback\.menuLabel/);
assert.match(appShell, /pagePath=\{feedbackPagePath\(pathname\)\}/);

const feedbackCore = read("spa/src/feedback.ts");
assert.match(feedbackCore, /pathname\.startsWith\("\/share\/"\)/);
assert.match(feedbackCore, /"\/share\/:token"/);

const dialog = read("spa/src/components/FeedbackDialog.tsx");
assert.match(dialog, /pushModal\(\)/);
assert.match(dialog, /role="dialog"/);
assert.match(dialog, /aria-modal="true"/);
assert.match(dialog, /role="radiogroup"/);
assert.match(dialog, /maxLength=\{FEEDBACK_MESSAGE_MAX\}/);
assert.match(dialog, /await submitFeedback/);
assert.match(dialog, /const \[initialPagePath\] = useState\(pagePath\)/);
assert.match(dialog, /pagePath: initialPagePath/);
assert.match(dialog, /confirmAction\(t\.feedback\.discardConfirm\)/);
assert.match(dialog, /requestCloseRef\.current\(\)/);
assert.doesNotMatch(dialog, /if \(event\.key === "Escape"\) onClose\(\)/);

const admin = read("spa/src/pages/AdminPage.tsx");
assert.match(admin, /\| "feedback"/);
assert.match(admin, /activeTab === "feedback"/);
assert.match(admin, /useInfiniteQuery/);
assert.match(admin, /getNextPageParam: \(lastPage\) => lastPage\.nextCursor/);
assert.match(
  admin,
  /enabled: Boolean\(user\?\.isAdmin && activeTab === "feedback"\)/,
);
assert.match(admin, /<FeedbackAdminPanel/);
assert.match(admin, /t\.admin\.tabFeedback/);

const adminPanel = read("spa/src/components/FeedbackAdminPanel.tsx");
for (const field of [
  "item.message",
  "item.userEmail",
  "item.pagePath",
  "item.client",
  "item.userAgent",
  "item.createdAt",
]) {
  assert.ok(
    adminPanel.includes(field),
    `admin feedback panel must show ${field}`,
  );
}
assert.match(adminPanel, /t\.admin\.feedbackLoadMore/);
assert.doesNotMatch(adminPanel, /t\.admin\.feedbackSubmittedAt/);

const accountDeletion = read("spa/src/components/AccountDeletionCard.tsx");
assert.match(accountDeletion, /t\.accountDeletion\.feedbackRecords/);

const privacyFeedbackLabels = {
  zh: "用户反馈",
  en: "User feedback",
  ja: "ユーザーフィードバック",
  fr: "Commentaires des utilisateurs",
};

for (const locale of ["zh", "en", "ja", "fr"]) {
  const messages = read(`spa/src/i18n/${locale}.ts`);
  assert.match(messages, /feedbackRecords:/);
  assert.match(messages, /discardConfirm:/);
  assert.match(messages, /feedbackLoadMore:/);
  const privacyStart = messages.indexOf("privacy: {");
  const privacyEnd = messages.indexOf("cookies: {", privacyStart);
  const privacy = messages.slice(privacyStart, privacyEnd);
  assert.ok(
    privacy.includes(privacyFeedbackLabels[locale]),
    `${locale} privacy policy must disclose collected feedback`,
  );
  assert.ok(
    privacy.match(/feedback|反馈|フィードバック|commentaire/gi)?.length >= 2,
    `${locale} privacy policy must disclose feedback retention separately`,
  );
}

const legalPage = read("spa/src/pages/LegalPage.tsx");
assert.match(legalPage, /const UPDATED = "2026-08-30"/);

console.log("feedback wiring: ok");
