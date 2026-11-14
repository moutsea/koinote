# Koi task constraint parsing patch

`task-constraint-scope.patch` contains the Agent service change required by Koinote 1.1.25, including its regression test. It projects persisted constraints into the interpreter’s internal scope schema without changing persisted state, authorization or billing.

Apply it to the production source archive for Worker version `ea613c75-9815-43e3-afa0-2dacebdf0b42` with `patch -p1 < task-constraint-scope.patch`. That archive already includes other applications’ released fixes; the current Agent working tree contains unrelated unpublished changes and must not be deployed wholesale.

The source archive and build evidence are kept under `~/.config/agent-gpt/production/releases/`. Validate types, deployment configuration and task intent/approval regression tests before deploying `agent-gpt` to production. Koinote’s GitHub deployment does not deploy this service. The Agent repository has no configured remote, so this patch is versioned here with the coordinated release.
