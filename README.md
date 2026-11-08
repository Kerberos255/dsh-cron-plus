# dsh-cron-plus

[English](README.en.md) | 简体中文

基于 DSH 原生 Schedule Service 的轻量工具插件：为指定的**已有会话**创建任务、改绑投递目标、暂停/恢复、立即投递一次，以及按名称查找任务或会话。不修改原生调度器和任务存储。

## 功能

| 工具 | 用途 |
|---|---|
| `cronplus_create` | 在指定已有 Session 创建原生定时任务，支持显式跨工作区 |
| `cronplus_edit` | `rebind` 改绑、`pause` 暂停、`resume` 恢复 |
| `cronplus_run` | 按完整任务 ID 立即投递一次，可跨工作区 |
| `cronplus_find` | `tasks` / `sessions` / `both` 查询；显示完整 ID 和工作区 |

原有 `schedule_create`、`schedule_list`、`schedule_view`、`schedule_edit` 保持可用。

## 使用要点

- **跨工作区**：创建或改绑新目标默认要求与调用会话同工作区；明确需要时传 `allow_cross_workspace=true`。`run` 可对其他工作区的任务执行，但会标注目标归属。
- **目标类型**：`session` 投递到已有会话；已有任务的 `new` / `new_once` 仍可暂停或恢复，改绑时只强校验新目标。旧目标已归档不会阻止迁出。
- **失败语义**：`created` / `updated` 是已受理结果；回执不明时使用 `unknown`，**不要直接重试写入或运行**，先只读检查。`run` 返回 `delivered` 只表示原生指令已投递，不保证 Agent 执行完成或渠道消息送达。
- **查询**：会话标题读取 DSH 的 Session 投影缓存，不调用飞书群名称 API；`lastActive` 与 `cacheUpdated` 是不同时间概念。`find(tasks)` 可查全宿主任务，须按完整任务 ID 区分同名条目。
- **使用边界**：这是面向可信个人环境的管理工具，原生 Schedule 具有宿主级任务访问权限，不提供按群成员隔离的身份 ACL。多用户部署应限制工具可见性。拒绝来自已识别委派子代理的写入和运行。

## 安装

需要 DSH 0.2.2 系列宿主，包含 `schedule`、`sessionQuery`、`dshHomePath` 等服务。将插件作为包加入 DSH Profile 的 `bundles`，并在**需要使用工具的 Agent 预设**中挂载 `dsh-cron-plus`。只加入 Profile 的 bundle，不加入 Agent 预设，工具可能不可见。

插件通过宿主 `dshHomePath` 发现数据目录；也可用 `DSH_HOME` 环境变量覆盖。可选设置 `CRONPLUS_LOG` 为指定日志文件的完整路径；未设置时不额外写入独立日志。

此插件只通过宿主 Schedule Service 修改任务；不要直接编辑任务存储文件。

## 开发和测试

```sh
npm test
node --check index.js
npm pack --dry-run
```

隔离测试使用模拟 Schedule / SessionQuery 与临时目录，不运行生产定时任务。宿主兼容性、真实渠道送达需要在独立测试配置中验证。

许可证：MIT。
