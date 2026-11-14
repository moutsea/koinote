# Koi task constraint parsing patch

`task-constraint-scope.patch` contains the Agent service change required by Koinote 1.1.25, including its regression test. It projects persisted constraints into the interpreter’s internal scope schema without changing persisted state, authorization or billing.

Apply it to an isolated copy of the **currently deployed** production source archive with `patch -p1 < task-constraint-scope.patch` after checking whether the fix is already present. The current Agent working tree contains unrelated unpublished changes and must not be deployed wholesale.

Agent is shared by multiple products. On 2026-11-14, the Koi fix in `1fed5eda-973e-43b3-bd07-bd123d25ba83` was overwritten by `a3815c5b-acd0-4715-8885-b7d26677b6c2`, whose release directory had been prepared from an older version. The latter added sandbox package support but omitted this fix. Restore the fix on top of that latest version, preserving its changes; rolling back the whole service would remove the package release.

Restored release: `23ecf95f-9a1c-4e50-85e6-c5e87540d207`, based on `a3815c5b-acd0-4715-8885-b7d26677b6c2`. Only `src/core/task-session.ts` changed at runtime. Validation: 74 related regression tests, type/config checks, deployment dry run, two complete-conversation interpretation replays, and an isolated production title-advice task using the same user evidence and persisted constraint. The production probe used no tools and did not modify user documents. Both health and readiness returned 200.

For every subsequent Agent release, run `npx wrangler deployments list --env production --json` and use the newest deployment's source archive as the baseline. Repeat the check immediately before deployment; if the active version has changed since preparation, stop and merge the newer release first. Keep this patch and regression test in the merged source. After deployment, verify the active version again and record the actual baseline, source archive and checks in `~/.config/agent-gpt/production/release-state.json`. An earlier successful deployment or a stale local release manifest does not prove that the fix is still running.

The source archive and build evidence are kept under `~/.config/agent-gpt/production/releases/`. Validate types, deployment configuration and task intent/approval regression tests before deploying `agent-gpt` to production. Koinote’s GitHub deployment does not deploy this service. The Agent repository has no configured remote, so this patch is versioned here with the coordinated release.
