# dsh-cron-plus

English | [简体中文](README.md)

A lightweight companion to DSH's native Schedule service. Add tasks targeting **existing sessions**, rebind delivery, pause/resume tasks, trigger one immediate delivery, and find tasks or sessions by title. It does not implement a separate scheduler or edit native schedule storage.

## Tools

| Tool | Purpose |
|---|---|
| `cronplus_create` | Create a native task for an existing Session, with optional cross-workspace targeting |
| `cronplus_edit` | `rebind` / `pause` / `resume` |
| `cronplus_run` | Deliver once by an exact task ID; cross-workspace execution is supported |
| `cronplus_find` | Search `tasks`, `sessions` or `both` and show full IDs with workspace context |

DSH's original `schedule_*` tools remain unchanged.

## Behavior and limitations

- Creation and rebinding require a destination in the caller's workspace by default; set `allow_cross_workspace=true` when deliberately targeting another workspace. Manual `run` can cross workspaces and reports the destination.
- Existing `new` and `new_once` tasks may be paused or resumed. Rebinding validates the **new** destination without treating an archived old destination as a reason to block migration.
- Ambiguous write outcomes return `unknown`. **Do not retry automatically**: inspect the native task list first. `delivered` on `run` means accepted by the native task inbox, not completion of the Agent or chat-channel delivery.
- Session titles come from DSH's projection cache rather than external provider APIs. `lastActive` and `cacheUpdated` are distinct timestamps.
- This plugin is designed for a trusted single-user deployment. The native Schedule service is host-wide; it does not enforce multi-user, per-channel access control. Restrict tool visibility in shared environments.

## Installation

Requires a compatible DSH host with `schedule`, `sessionQuery` and `dshHomePath` services. Add the package to the Profile's bundles **and** mount `dsh-cron-plus` in the Agent preset that should receive these tools.

The plugin resolves its data root from DSH's `dshHomePath` service. `DSH_HOME` can override it. Set `CRONPLUS_LOG` to an absolute log-file path to enable an optional separate log.

Tasks are managed through the native Schedule Service; never directly edit its persistence files.

## Development

```sh
npm test
node --check index.js
npm pack --dry-run
```

Tests use a mocked Schedule/SessionQuery and temporary directories. Validate deployment and external delivery separately in an isolated DSH profile.

MIT License.
