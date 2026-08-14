# Koinote Product Roadmap

This roadmap records the product and engineering directions currently worth the most investment. It is not a release-date commitment; priorities may change with user feedback, security risk, and maintenance cost.

## P0: Near-term priorities

- [x] Account security: password recovery, password changes, and invalidating sessions on other devices.
- [x] Mobile editor: replace the desktop document tree with a mobile document drawer.
- [ ] Backup and recovery: create a verifiable, downloadable, and restorable site backup workflow.
- [x] Data portability: bulk-import `.md`, folders, and ZIP archives, and export every document, folder, and image at once.
- [ ] Account deletion: provide a self-service way to remove the account and all associated data.
- [ ] Lifetime-plan boundaries: document the long-term rules for storage, future AI access, and exceptional cost.

## P1: Core experience

- [x] Global title/body search with a keyboard launcher, highlighted results, and quick navigation.
- [x] Bulk Markdown migration using files, folders, or ZIP archives together with referenced images.
- [ ] MCP activity logs for Agent reads, writes, conflicts, and reversals.
- [ ] Document-level access rules for MCP tokens and folders.
- [x] Share growth features: dynamic titles, OpenGraph cards, read counts, and “Copy to my Koinote”.
- [x] Privacy-conscious first-milestone funnels and retention without content, titles, search terms, or filenames.

## P2: Later exploration

- [ ] Controlled native AI that is explicitly invoked and exposes model, cost, and data boundaries.
- [ ] Publishing workflows for destination status, update history, and exports.
- [ ] Offline and PWA support for weak networks and draft synchronization.
- [ ] Readable line- or block-level diffs for document history.

## Principles

- Documents are private by default, and authorization is enforced by the backend.
- Agent writes keep concurrency protection and a recovery boundary.
- New capabilities favor open formats and standard protocols to preserve portability.
- Security, backups, and data migration take priority over decorative features.
