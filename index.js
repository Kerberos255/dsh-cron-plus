/**
 * Cron Plus exposes additional tools over the native DSH Schedule service.
 * No separate scheduler, direct schedule storage edits, or persistent timers.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const VERSION = '0.2.10'
const TAG = '[cron-plus]'

/**
 * 数据目录。默认是本机 DSH 的固定位置，但允许用环境变量覆盖：
 *   DSH_HOME         → 该目录下的 storages / session_projcache
 *   CRONPLUS_LOG     → 日志文件完整路径
 * 这样换机器或换 profile 时不用改代码。
 */
// Resolve DSH data roots from the Host at plugin construction.
const LOG_PATH = process.env.CRONPLUS_LOG ?? null

/** 官方 scheduleTitle 的上限，保持一致 */
const MAX_TITLE_LENGTH = 120
/** 官方没有 prompt 上限，这里给一个远高于真实需要的护栏 */
const MAX_PROMPT_LENGTH = 100_000

/** projcache 并发读取上限 */
const SCAN_CONCURRENCY = 32

const SHANGHAI_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const SHANGHAI_FMT_FULL = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function log(msg) {
  if (!LOG_PATH) return
  const line = `${new Date().toISOString()} ${TAG} ${msg}`
  try {
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8')
  } catch {
    /* 日志失败不影响功能 */
  }
}

/**
 * epoch 毫秒 → 北京时间 "MM-DD HH:mm"。
 * 用 Intl 显式指定 Asia/Shanghai，不依赖操作系统时区。
 */
function fmtLocal(ms) {
  if (!ms || Number.isNaN(ms)) return '-'
  try {
    return SHANGHAI_FMT.format(new Date(ms)).replace(/\//g, '-')
  } catch {
    return '-'
  }
}

/** 带年份的完整北京时间，用于需要绝对时间的场合 */
function fmtLocalFull(ms) {
  if (!ms || Number.isNaN(ms)) return '-'
  try {
    return SHANGHAI_FMT_FULL.format(new Date(ms)).replace(/\//g, '-')
  } catch {
    return '-'
  }
}

// ============================================================
// 归档状态
// ============================================================

/**
 * 已归档 Session 集合缓存。
 * workspace.json 会被归档操作改写，靠 mtime 判断是否失效。
 */
const archivedCaches = new Map()

async function readArchivedSessions(workspaceJson) {
  if (!workspaceJson) return { ids: new Set(), stale: true }
  const cached = archivedCaches.get(workspaceJson) ?? { mtimeMs: 0, ids: new Set() }
  try {
    const st = await fsp.stat(workspaceJson)
    if (st.mtimeMs === cached.mtimeMs) return { ids: cached.ids, stale: false }
    const parsed = JSON.parse(await fsp.readFile(workspaceJson, 'utf8'))
    const entries = parsed?.global?.archivedSessionIds
    if (!Array.isArray(entries) || !entries.every(id => typeof id === 'string')) {
      throw new Error('workspace archive metadata invalid')
    }
    const ids = new Set(entries)
    archivedCaches.set(workspaceJson, { mtimeMs: st.mtimeMs, ids })
    return { ids, stale: false }
  } catch (err) {
    log('readArchivedSessions unavailable: ' + String(err?.message ?? err))
    // Native Scheduler makes the final target validity decision.
    return { ids: cached.ids, stale: true }
  }
}

// ============================================================
// projcache 标题扫描
// ============================================================

/**
 * 从 projcache 提取会话标题。
 *
 * 标题在投影 JSON 里的结构是：
 *   "title": { "ver": 1, "seq": 12149, "val": "飞书" }
 * 先做一次开销极低的字符串定位（确认文件里有 title 投影），
 * 再对命中的文件做 JSON.parse 取准确值 —— 特殊转义、引号、Unicode
 * 都由 JSON 解析器处理，不用正则硬抠字符串。
 *
 * 返回 Map<sessionId, { title, cacheUpdatedAt, bytes }>。
 * cacheUpdatedAt 是 projcache 文件的 mtime，只代表「投影缓存最后写入时间」，
 * 不等于「会话最后一次发言」，展示时必须按前者表述。
 *
 * 异步 + 有界并发，避免 1000+ 文件同步 IO 阻塞事件循环。
 */
async function scanProjcacheTitles(projcacheDir) {
  const map = new Map()
  let names
  try {
    if (!projcacheDir) throw new Error('DSH home unavailable: configure DSH_HOME or inject dshHomePath')
    names = await fsp.readdir(projcacheDir)
  } catch (err) {
    log(`scanProjcacheTitles: readdir 失败 ${err?.message ?? err}`)
    throw err
  }

  const files = names.filter((n) => n.endsWith('.json'))
  let cursor = 0

  async function worker() {
    while (cursor < files.length) {
      const idx = cursor++
      const name = files[idx]
      const full = path.join(projcacheDir, name)
      // 文件名 = <完整 sessionId>.json，不要剥 "session-" 前缀：
      // 普通会话 header.id 自带 session-，子代理会话不带，两者都要原样对上。
      const sid = name.slice(0, -'.json'.length)
      try {
        const raw = await fsp.readFile(full, 'utf8')
        // 快速排除：没有 title 投影的文件直接跳过，不付 JSON.parse 的代价
        if (!raw.includes('"title"')) continue
        const parsed = JSON.parse(raw)
        // 投影结构：record.rows.<key>，title 可能是字符串，
        // 也可能是 { ver, seq, val } 的带版本快照，两种都接受。
        const rows = parsed?.record?.rows
        const t = rows?.title
        const title =
          typeof t === 'string' ? t.trim() : typeof t?.val === 'string' ? t.val.trim() : ''
        if (!title) continue
        const st = await fsp.stat(full)
        // 投影行有两种外形：直接是值，或 { ver, seq, val } 的带版本快照。
        // 统一 unwrap 取内层值。
        const unwrap = (v) => (v && typeof v === 'object' && 'val' in v ? v.val : v)
        // lastPromptAt 是会话最后一次用户输入的毫秒时间戳，
        // 比文件 mtime（受任意投影写入影响）更接近「最后活跃」。
        const meta = unwrap(rows?.sessionListMetadata)
        const lastPromptAt = meta?.lastPromptAt
        const lastActiveAt =
          typeof lastPromptAt === 'number' && Number.isFinite(lastPromptAt) ? lastPromptAt : null
        map.set(sid, { title, cacheUpdatedAt: st.mtimeMs, lastActiveAt, bytes: st.size })
      } catch {
        /* 单个文件损坏不影响整体 */
      }
    }
  }

  const workers = []
  const n = Math.min(SCAN_CONCURRENCY, files.length)
  for (let i = 0; i < n; i++) workers.push(worker())
  await Promise.all(workers)

  return map
}

// ============================================================
// 调用者与目标校验
// ============================================================

/** 从 exec 里取调用者上下文；取不到就抛错 */
function actorOf(exec) {
  const agent = exec?.agent
  const session = agent?.session
  const header = session?.header
  if (!session?.id) {
    throw new CronPlusInputError(
      'cronplus_no_actor',
      '无法确定调用者会话（exec.agent.session 缺失），本次操作已拒绝。',
    )
  }
  return {
    sessionId: session.id,
    cwd: header?.cwd ?? null,
    origin: header?.origin ?? null,
    delegationDepth: header?.delegationDepth ?? 0,
    parentSession: header?.parentSession ?? null,
  }
}

/**
 * 判断一个 Session header 是否属于委派子代理。
 *
 * 只用 header 上可独立成立的信号：
 *   · origin === 'subagent'
 *   · delegationDepth > 0
 *
 * 不把「有 parentSession」单独当成子代理——普通 fork 出来的对话也会带
 * parentSession，官方 hasApiSessionSubagentOwner 还需要配合运行时 Agent
 * 才能判定，插件侧拿不到那个信息，按 parentSession 一刀切会误伤正常会话。
 */
function isDelegatedHeader(header) {
  if (!header) return false
  if (header.origin === 'subagent') return true
  if ((header.delegationDepth ?? 0) > 0) return true
  return false
}

/** 拒绝 delegated 子代理发起跨会话写操作 */
function assertNotDelegated(actor, action) {
  if (isDelegatedHeader(actor)) {
    throw new CronPlusInputError(
      'cronplus_delegated',
      `拒绝 ${action}：当前调用来自委派子代理（origin=${actor.origin}, depth=${actor.delegationDepth}）。` +
        '跨会话的定时任务写操作只能由主会话发起。',
    )
  }
}

/**
 * 强校验：目标必须是存在、未归档、非委派、且（默认）同 cwd 的会话。
 * 只用于 create 的目标和 rebind 的**新**目标。
 *
 * @returns {{ header: object, cwd: string|null }}
 */
async function verifyTarget(sessionQuery, targetId, actor, allowCrossWorkspace, workspaceJson) {
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new CronPlusInputError('cronplus_bad_target', 'target_session_id 不能为空。')
  }

  const records = await sessionQuery.filterSessions([{ kind: 'id', values: [targetId] }])
  if (!records || records.length === 0) {
    throw new CronPlusInputError(
      'cronplus_target_missing',
      `目标会话 ${targetId} 不存在或无法读取，本次操作已拒绝。`,
    )
  }

  const header = records[0].header

  if (isDelegatedHeader(header)) {
    throw new CronPlusInputError(
      'cronplus_target_delegated',
      `目标会话 ${targetId} 是委派子代理会话，不能作为定时任务投递目标。`,
    )
  }

  const archived = await readArchivedSessions(workspaceJson)
  if (archived.ids.has(String(header.id))) {
    throw new CronPlusInputError(
      'cronplus_target_archived',
      `目标会话 ${targetId} 已归档，不能作为定时任务的投递目标。请在界面里取消归档，或换一个活跃会话。`,
    )
  }

  if (!allowCrossWorkspace) {
    if (!actor.cwd) {
      throw new CronPlusInputError(
        'cronplus_no_cwd',
        '无法确定调用者工作目录，默认拒绝跨会话写入；如确需操作请显式传 allow_cross_workspace=true。',
      )
    }
    if (header.cwd !== actor.cwd) {
      throw new CronPlusInputError(
        'cronplus_cross_workspace',
        `目标会话 ${targetId} 的工作目录（${header.cwd ?? '(未设置)'}）与当前（${actor.cwd}）不同。` +
          '默认拒绝跨工作区操作；如确需，请显式传 allow_cross_workspace=true。',
      )
    }
  }

  return { header, cwd: header.cwd ?? null }
}

/**
 * 只读描述：说明一个目标的归属，不做任何阻断。
 * 用于 run 的回执、edit 的旧目标、find(tasks) 的工作区标注。
 *
 * 返回 { kind, sessionId, cwd, workspace, note }：
 *   workspace = 'current' | 'other' | 'unknown'
 * 拿不到真实 cwd 时诚实标 unknown，绝不冒充 current。
 */
async function describeTarget(target, sessionQuery, actor) {
  if (!target) return { kind: '?', sessionId: null, cwd: null, workspace: 'unknown', note: '目标缺失' }

  if (target.kind === 'session' || target.kind === 'new_once') {
    const sid = target.sessionId ? String(target.sessionId) : null
    if (!sid) {
      return { kind: target.kind, sessionId: null, cwd: null, workspace: 'unknown', note: '无 Session ID' }
    }
    let cwd = null
    try {
      const recs = await sessionQuery.filterSessions([{ kind: 'id', values: [sid] }])
      cwd = recs?.[0]?.header?.cwd ?? null
    } catch (err) {
      log(`describeTarget lookup failed: ${err?.message ?? err}`)
    }
    // new_once 还没启动时查不到 header，退回 target.create.cwd
    if (cwd == null && target.create?.cwd) cwd = target.create.cwd
    let workspace = 'unknown'
    if (cwd && actor.cwd) workspace = cwd === actor.cwd ? 'current' : 'other'
    return { kind: target.kind, sessionId: sid, cwd, workspace, note: '' }
  }

  if (target.kind === 'new') {
    const cwd = target.create?.cwd ?? null
    let workspace = 'unknown'
    if (cwd && actor.cwd) workspace = cwd === actor.cwd ? 'current' : 'other'
    return { kind: 'new', sessionId: null, cwd, workspace, note: cwd ? '' : '未记录创建目录' }
  }

  return { kind: target.kind ?? '?', sessionId: null, cwd: null, workspace: 'unknown', note: '未知目标类型' }
}

const WORKSPACE_LABEL = {
  current: '当前工作区',
  other: '其他工作区',
  unknown: '工作区未知',
}

// ============================================================
// 错误分类（P0）
// ============================================================

/**
 * 插件自身的确定性拒绝：委派拦截、目标校验不通过、参数非法。
 * 这类错误发生在调用原生 Service 之前，可以断言「没有写盘」。
 * 打上稳定 code，让 isDefiniteInputError 能识别，不走「不确定」分支。
 */
class CronPlusInputError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CronPlusInputError'
    this.code = code
  }
}

/**
 * 判断一个错误是否属于「确定的输入校验失败」。
 *
 * 两类来源：
 *   1. 插件自身的前置校验（CronPlusInputError），发生在调用 Service 之前；
 *   2. 官方 create/edit 在写盘前抛出的 ScheduleInputError，带稳定 code：
 *        invalid_prompt     title/prompt 不合法
 *        invalid_rule       rrule、目标归档/不存在等
 *        subagent_session   目标是委派子会话
 *
 * 带这些 code 时可以断言「没有写盘」。
 * 其它错误（超时、断连、序列化失败、queueNotification 抛错）都可能发生在
 * put 之后，必须按「不确定」处理。
 */
function isDefiniteInputError(err) {
  if (!err) return false
  const code = err.code
  if (typeof code !== 'string') return false
  if (code.startsWith('cronplus_')) return true
  if (code === 'invalid_prompt' || code === 'invalid_rule' || code === 'subagent_session') return true
  // 仅 schedule/input-invalid 明确属于写入前的校验失败；
  // schedule/unknown-state 等包装可能发生在持久写入后，不能当作确定失败。
  if (code === 'schedule/input-invalid') return true
  return false
}

/** 从任意错误里提取可读文本 */
function errText(err) {
  if (!err) return '未知错误'
  const parts = []
  if (err.code) parts.push(`[${err.code}]`)
  if (err.message) parts.push(String(err.message))
  if (parts.length === 0) parts.push(String(err))
  return parts.join(' ')
}

// ============================================================
// 插件
// ============================================================

export default class CronPlus {
  static inject = ['tools', 'dshHomePath']

  constructor(ctx) {
    const home = process.env.DSH_HOME || (
      typeof ctx.dshHomePath === 'function' ? ctx.dshHomePath() :
      typeof ctx.get?.('dshHomePath') === 'function' ? ctx.get('dshHomePath')() : null
    )
    const storageDir = home ? path.join(home, 'storages') : null
    const workspaceJson = storageDir ? path.join(storageDir, 'workspace.json') : null
    const projcacheDir = storageDir ? path.join(storageDir, 'session_projcache', 'sessions') : null
    log(`--- plugin constructed (v${VERSION}) ---`)

    ctx.inject(['schedule', 'sessionQuery', 'tools'], (scope) => {
      const schedule = scope.get('schedule')
      const sessionQuery = scope.get('sessionQuery')
      const tools = scope.get('tools')

      if (!schedule || !sessionQuery || !tools) {
        log('skip registration: 有服务缺失')
        return
      }

      log('registering 4 tools')

      // ==========================================================
      // 1. cronplus_create
      // ==========================================================
      scope.tools.register({
        name: 'cronplus_create',
        description:
          '创建定时任务并投递到指定的已存在 Session。扩展官方 schedule_create：官方只支持 this_session / new_once / new，本工具支持任意已存在的会话。默认要求目标与当前同工作目录；目标必须存在、未归档、非委派子会话。',
        parameters: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: `任务名，含动作+对象，不超过 ${MAX_TITLE_LENGTH} 字`,
            },
            prompt: {
              type: 'string',
              description: '到期时投递的完整指令（自包含，不依赖当前对话上下文）',
            },
            rrule: {
              type: 'string',
              description: 'RFC5545 子集：DTSTART 行 + RRULE 行，用换行分隔',
            },
            target_session_id: { type: 'string', description: '投递目标 Session ID' },
            allow_cross_workspace: {
              type: 'boolean',
              description: '显式允许投递到其他工作目录的会话；默认 false',
            },
          },
          required: ['title', 'prompt', 'rrule', 'target_session_id'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              state: {
                type: 'string',
                enum: ['created', 'failed', 'unknown'],
                description: 'created=已确认创建；failed=确定未创建；unknown=结果不确定，可能已创建',
              },
              id: { type: 'string' },
              title: { type: 'string' },
              target: { type: 'string' },
              workspace: { type: 'string' },
              scheduledAt: { type: 'string' },
              retryable: { type: 'boolean' },
              suspects: { type: 'array', items: { type: 'string' } },
              message: { type: 'string' },
            },
            additionalProperties: false,
          },
          render(args, value) {
            const v = value ?? {}
            if (v.state === 'created') {
              return [
                {
                  type: 'text',
                  text: `已创建任务\nid: ${v.id}\n标题: ${v.title}\n目标: ${v.target}（${v.workspace}）\n下次: ${v.scheduledAt}`,
                },
              ]
            }
            if (v.state === 'unknown') {
              const lines = [
                '创建结果不确定：可能已经创建成功，也可能没有。',
                `原因: ${v.message}`,
                '',
                '**不要直接重试**。先用 cronplus_find 只读核对是否真的建出来了；',
                '确认没有之后再重新创建，避免重复投递。',
              ]
              if (v.suspects?.length) {
                lines.push('', '疑似已创建（标题+目标+时间窗匹配）：')
                lines.push(...v.suspects.map((s) => `- ${s}`))
              }
              return [{ type: 'text', text: lines.join('\n') }]
            }
            return [{ type: 'text', text: `创建失败（确定未创建）: ${v.message}` }]
          },
        },
        async execute(args, exec) {
          const startedAt = Date.now()
          const base = {
            state: 'failed',
            id: '',
            title: '',
            target: '',
            workspace: '',
            scheduledAt: '',
            retryable: false,
            suspects: [],
            message: '',
          }
          try {
            const actor = actorOf(exec)
            assertNotDelegated(actor, 'cronplus_create')

            if (typeof args.title !== 'string' || args.title.trim().length === 0) {
              throw new CronPlusInputError('cronplus_bad_title', 'title 不能为空。')
            }
            if (args.title.trim().length > MAX_TITLE_LENGTH) {
              throw new CronPlusInputError(
                'cronplus_bad_title',
                `title 长度 ${args.title.trim().length} 超过官方上限 ${MAX_TITLE_LENGTH}。`,
              )
            }
            if (typeof args.prompt !== 'string' || args.prompt.length > MAX_PROMPT_LENGTH) {
              throw new CronPlusInputError(
                'cronplus_bad_prompt',
                `prompt 长度 ${args.prompt?.length ?? 0} 超过上限 ${MAX_PROMPT_LENGTH}；长内容请放进脚本由任务调用。`,
              )
            }

            const { cwd } = await verifyTarget(
              sessionQuery,
              args.target_session_id,
              actor,
              !!args.allow_cross_workspace,
              workspaceJson,
            )

            const created = await schedule.create(
              {
                title: args.title,
                prompt: args.prompt,
                timing: { kind: 'rrule', rrule: args.rrule },
                target: { kind: 'session', sessionId: args.target_session_id },
              },
              actor.sessionId,
              exec.signal,
            )

            log(`create ok id=${created.id} target=${args.target_session_id}`)
            return {
              ...base,
              state: 'created',
              id: String(created.id),
              title: String(created.title ?? ''),
              target: `session:${args.target_session_id}`,
              workspace: cwd === actor.cwd ? WORKSPACE_LABEL.current : WORKSPACE_LABEL.other,
              scheduledAt: created.scheduledAt ? fmtLocal(Date.parse(created.scheduledAt)) : '(未知)',
            }
          } catch (err) {
            const msg = errText(err)

            // 输入校验类错误：官方在写盘前抛出，可以断言未创建
            if (isDefiniteInputError(err)) {
              log(`create failed(definite): ${msg}`)
              return { ...base, state: 'failed', message: msg }
            }

            // 其余情况都可能发生在 put 之后，做一次只读核对再下结论
            log(`create uncertain: ${msg} —— 开始只读核对`)
            let suspects = []
            try {
              const all = await schedule.catalog()
              const sinceIso = new Date(startedAt - 2000).toISOString()
              suspects = (all ?? [])
                .filter((t) => {
                  if (String(t.title ?? '') !== args.title) return false
                  if (String(t.target?.sessionId ?? '') !== String(args.target_session_id)) return false
                  if (String(t.prompt ?? '') !== String(args.prompt)) return false
                  const created = t.createdAt ? Date.parse(t.createdAt) : 0
                  return created >= Date.parse(sinceIso)
                })
                .map((t) => `${t.id} | ${t.title} | ${fmtLocal(Date.parse(t.createdAt ?? 0))}`)
            } catch (lookupErr) {
              log(`create 核对失败: ${errText(lookupErr)}`)
            }

            return {
              ...base,
              state: 'unknown',
              retryable: false,
              suspects,
              message: msg,
            }
          }
        },
      })

      // ==========================================================
      // 2. cronplus_edit
      // ==========================================================
      scope.tools.register({
        name: 'cronplus_edit',
        description:
          '编辑已有定时任务：action=rebind 改绑投递目标（可跨工作区，需 allow_cross_workspace）；action=pause 暂停；action=resume 恢复。改绑需 target_session_id，其它 action 不接受该参数。暂停不要求旧目标仍有效。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '任务 ID' },
            action: {
              type: 'string',
              enum: ['rebind', 'pause', 'resume'],
              description: 'rebind 改绑目标；pause 暂停；resume 恢复',
            },
            target_session_id: { type: 'string', description: '仅 action=rebind 时必填' },
            allow_cross_workspace: {
              type: 'boolean',
              description: '仅 action=rebind 时生效：允许目标位于其他工作目录；默认 false',
            },
          },
          required: ['id', 'action'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              state: {
                type: 'string',
                enum: ['updated', 'failed', 'unknown', 'conflict', 'not_found'],
              },
              id: { type: 'string' },
              action: { type: 'string' },
              status: { type: 'string' },
              oldTarget: { type: 'string' },
              newTarget: { type: 'string' },
              scheduledAt: { type: 'string' },
              verified: { type: 'boolean' },
              retryable: { type: 'boolean' },
              message: { type: 'string' },
            },
            additionalProperties: false,
          },
          render(args, value) {
            const v = value ?? {}
            const lines = []
            if (v.state === 'updated') {
              lines.push(`${v.action} 成功${v.verified ? '（已回读确认）' : '（已提交，但最终状态未确认）'}`)
              lines.push(`id: ${v.id}`)
              lines.push(`状态: ${v.status}`)
              if (v.oldTarget) lines.push(`原目标: ${v.oldTarget}`)
              if (v.newTarget) lines.push(`新目标: ${v.newTarget}`)
              lines.push(`下次: ${v.scheduledAt}`)
            } else if (v.state === 'unknown') {
              lines.push(`${v.action} 结果不确定：可能已经生效。`)
              lines.push(`原因: ${v.message}`)
              lines.push('')
              lines.push('**不要直接重试**，先用 cronplus_find 只读核对当前状态。')
            } else if (v.state === 'conflict') {
              lines.push(`${v.action} 未执行：任务已被其他操作修改。`)
              lines.push(v.message)
            } else if (v.state === 'not_found') {
              lines.push(`任务 ${v.id} 不存在或不可见。`)
            } else {
              lines.push(`${v.action ?? 'edit'} 失败（确定未生效）: ${v.message}`)
            }
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        async execute(args, exec) {
          const action = args.action
          const base = {
            state: 'failed',
            id: args.id ?? '',
            action,
            status: '',
            oldTarget: '',
            newTarget: '',
            scheduledAt: '',
            verified: false,
            retryable: false,
            message: '',
          }
          try {
            const actor = actorOf(exec)
            assertNotDelegated(actor, `cronplus_edit(${action})`)

            if (action === 'rebind') {
              if (!args.target_session_id) {
                throw new CronPlusInputError(
                  'cronplus_bad_target',
                  'action=rebind 必须提供 target_session_id。',
                )
              }
            } else if (args.target_session_id) {
              throw new CronPlusInputError(
                'cronplus_bad_target',
                `action=${action} 不接受 target_session_id 参数。`,
              )
            }

            // 先读当前任务
            const current = await schedule.view({ id: args.id })
            if (!current || current.code === 'schedule_not_found') {
              return { ...base, state: 'not_found' }
            }

            // 旧目标只做归属说明，不做阻断：
            // 官方 edit 在 pause 时不 validateTarget，归档目标本来就允许暂停。
            const oldDesc = await describeTarget(current.target, sessionQuery, actor)
            const oldLabel =
              oldDesc.kind === 'session' || oldDesc.kind === 'new_once'
                ? `${oldDesc.kind}:${oldDesc.sessionId ?? '-'}（${WORKSPACE_LABEL[oldDesc.workspace]}${oldDesc.cwd ? ' ' + oldDesc.cwd : ''}）`
                : `${oldDesc.kind}（${WORKSPACE_LABEL[oldDesc.workspace]}${oldDesc.cwd ? ' ' + oldDesc.cwd : ''}）`

            // 新目标才强校验
            let newDesc = null
            if (action === 'rebind') {
              const { cwd } = await verifyTarget(
                sessionQuery,
                args.target_session_id,
                actor,
                !!args.allow_cross_workspace,
                workspaceJson,
              )
              newDesc = {
                label: `session:${args.target_session_id}（${
                  cwd === actor.cwd ? WORKSPACE_LABEL.current : WORKSPACE_LABEL.other
                } ${cwd ?? '-'}）`,
              }
            }

            const patch = {}
            if (action === 'rebind') {
              patch.target = { kind: 'session', sessionId: args.target_session_id }
            } else if (action === 'pause') {
              patch.active = false
            } else if (action === 'resume') {
              patch.active = true
            }

            const updated = await schedule.edit(
              {
                id: args.id,
                action: 'update',
                patch,
                expectedUpdatedAt: current.updatedAt ?? null,
              },
              actor.sessionId,
              exec.signal,
            )

            if (updated?.code === 'schedule_conflict') {
              log(`${action} conflict id=${args.id}`)
              return { ...base, state: 'conflict', message: '任务已被其他操作修改，请重新读取后再试（未强行覆盖）。' }
            }
            if (updated?.code === 'schedule_not_found') {
              return { ...base, state: 'not_found' }
            }

            // 回读确认（P1-5）
            let verified = false
            let final = updated
            try {
              const reread = await schedule.view({ id: args.id })
              if (reread && reread.code !== 'schedule_not_found') {
                final = reread
                verified = true
                if (action === 'rebind') {
                  verified = String(reread.target?.sessionId ?? '') === String(args.target_session_id)
                } else if (action === 'pause') {
                  verified = reread.status === 'paused'
                } else if (action === 'resume') {
                  verified = reread.status === 'active'
                }
              }
            } catch (rereadErr) {
              log(`${action} 回读失败: ${errText(rereadErr)}`)
              verified = false
            }

            log(`${action} ok id=${args.id} verified=${verified}`)
            return {
              ...base,
              state: 'updated',
              id: String(final.id ?? args.id),
              status: String(final.status ?? ''),
              oldTarget: oldLabel,
              newTarget: newDesc?.label ?? '',
              scheduledAt: final.scheduledAt ? fmtLocal(Date.parse(final.scheduledAt)) : '(未知)',
              verified,
              message: verified ? '' : '写入已提交，但回读未能确认最终状态。',
            }
          } catch (err) {
            const msg = errText(err)
            if (isDefiniteInputError(err)) {
              log(`${action} failed(definite): ${msg}`)
              return { ...base, state: 'failed', message: msg }
            }
            log(`${action} uncertain: ${msg}`)
            return { ...base, state: 'unknown', retryable: false, message: msg }
          }
        },
      })

      // ==========================================================
      // 3. cronplus_run
      // ==========================================================
      scope.tools.register({
        name: 'cronplus_run',
        description:
          '立即投递一次定时任务，不消耗也不移动它的正常计划时刻。允许运行其他工作区的任务（按完整任务 ID 指定），回执会标明目标归属。会产生真实副作用：目标会话可能执行脚本或发送消息。成功只代表已投递到目标收件箱，不代表模型已执行或渠道已送达。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '任务 ID（完整 ID，避免同名歧义）' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              result: {
                type: 'string',
                enum: ['delivered', 'pending', 'not_found', 'unknown', 'failed'],
              },
              id: { type: 'string' },
              title: { type: 'string' },
              targetKind: { type: 'string' },
              targetSession: { type: 'string' },
              targetCwd: { type: 'string' },
              workspace: { type: 'string' },
              retryable: { type: 'boolean' },
              message: { type: 'string' },
            },
            additionalProperties: false,
          },
          render(args, value) {
            const v = value ?? {}
            const lines = [`${v.result}: ${v.message}`]
            if (v.title) lines.push(`任务: ${v.title}`)
            if (v.targetKind) {
              lines.push(
                `目标: ${v.targetKind}${v.targetSession ? ':' + v.targetSession : ''}` +
                  `（${v.workspace ?? '工作区未知'}${v.targetCwd ? ' ' + v.targetCwd : ''}）`,
              )
            }
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        async execute(args, exec) {
          const base = {
            result: 'failed',
            id: args.id ?? '',
            title: '',
            targetKind: '',
            targetSession: '',
            targetCwd: '',
            workspace: '',
            retryable: false,
            message: '',
          }
          try {
            const actor = actorOf(exec)
            assertNotDelegated(actor, 'cronplus_run')

            // 只读读取任务信息，用于回执里标明「执行的是哪一项、在哪个工作区」
            let task = null
            try {
              task = await schedule.view({ id: args.id })
            } catch (viewErr) {
              // 任务详情读取失败不是「任务不存在」，且尚未调用 run。
              log(`run view failed: ${errText(viewErr)}`)
              return { ...base, result: 'failed', message: `读取任务信息失败，本次尚未触发执行：${errText(viewErr)}` }
            }
            if (!task) {
              return { ...base, result: 'failed', message: '任务详情不可读，本次尚未触发执行' }
            }
            if (task.code === 'schedule_not_found') {
              return { ...base, result: 'not_found', message: '任务不存在或不可见' }
            }

            const desc = await describeTarget(task.target, sessionQuery, actor)

            const result = await schedule.run({ id: args.id }, exec.signal)

            let mapped
            if (result?.code === 'schedule_not_found') {
              mapped = { result: 'not_found', message: '任务不存在或不可见' }
            } else if (result?.code === 'schedule_execution_pending') {
              mapped = { result: 'pending', message: '上一轮执行尚未完成，本次未重复触发' }
            } else if (result?.id) {
              mapped = {
                result: 'delivered',
                message:
                  '已投递到目标会话的收件箱（不代表 Agent 已执行完成，也不代表渠道消息已送达）',
              }
            } else {
              mapped = { result: 'unknown', message: '原生 run 返回了未识别的结构' }
            }

            log(`run id=${args.id} result=${mapped.result} workspace=${desc.workspace}`)
            return {
              ...base,
              ...mapped,
              title: String(task.title ?? ''),
              targetKind: desc.kind,
              targetSession: desc.sessionId ?? '',
              targetCwd: desc.cwd ?? '',
              workspace: WORKSPACE_LABEL[desc.workspace],
            }
          } catch (err) {
            const msg = errText(err)
            // run 是「投递」操作：不确定时同样不能重试
            log(`run uncertain: ${msg}`)
            return { ...base, result: 'unknown', retryable: false, message: msg }
          }
        },
      })

      // ==========================================================
      // 4. cronplus_find
      // ==========================================================
      scope.tools.register({
        name: 'cronplus_find',
        description:
          '查找定时任务或可绑定的 Session。mode=tasks 查全宿主任务（返回完整 ID 与目标工作区）；mode=sessions 列出有标题的会话（与 Web GUI 显示基本一致）；mode=both 两者都查。默认只列有标题的会话，因为无标题的通常是历史残留。',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['tasks', 'sessions', 'both'], description: '默认 tasks' },
            query: { type: 'string', description: '标题关键字（可选，大小写不敏感）' },
            limit: { type: 'integer', description: '最多返回条数，默认 20，上限 50' },
            include_unnamed: {
              type: 'boolean',
              description: '是否包含无标题会话（默认 false，会列出上千条历史）',
            },
            include_subagent: {
              type: 'boolean',
              description: '是否包含委派子代理会话（默认 false，它们不是对话）',
            },
            allow_cross_workspace: {
              type: 'boolean',
              description: 'sessions 模式下是否列出其他工作目录的会话；默认 false',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              tasks: { type: 'array', items: { type: 'string' } },
              sessions: { type: 'array', items: { type: 'string' } },
              totalNamed: { type: 'number' },
              elapsedMs: { type: 'number' },
              message: { type: 'string' },
            },
            additionalProperties: false,
          },
          render(args, value) {
            const v = value ?? {}
            const lines = []
            if (v.tasks?.length) {
              lines.push('任务：')
              lines.push(...v.tasks.map((t) => `- ${t}`))
            }
            if (v.sessions?.length) {
              lines.push('会话：')
              lines.push(...v.sessions.map((s) => `- ${s}`))
            }
            if (lines.length === 0) lines.push('未找到匹配项')
            if (v.message) {
              lines.push('')
              lines.push(v.message)
            }
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        async execute(args, exec) {
          const mode = args.mode ?? 'tasks'
          const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50)
          const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
          const includeUnnamed = args.include_unnamed === true
          const includeSubagent = args.include_subagent === true
          const started = Date.now()
          const out = {
            ok: true,
            tasks: [],
            sessions: [],
            totalNamed: 0,
            elapsedMs: 0,
            message: '',
          }

          try {
            const actor = actorOf(exec)

            // ---------------- tasks ----------------
            if (mode === 'tasks' || mode === 'both') {
              const all = await schedule.catalog()
              const matched = (all ?? []).filter((t) => {
                if (!q) return true
                return String(t.title ?? '').toLowerCase().includes(q)
              })

              const picked = matched.slice(0, limit)

              // 批量查 session 型目标的 cwd
              const sessionTargets = [
                ...new Set(
                  picked
                    .filter((t) => (t.target?.kind === 'session' || t.target?.kind === 'new_once') && t.target.sessionId)
                    .map((t) => String(t.target.sessionId)),
                ),
              ]
              const cwdMap = new Map()
              if (sessionTargets.length > 0) {
                try {
                  const recs = await sessionQuery.filterSessions([
                    { kind: 'id', values: sessionTargets },
                  ])
                  for (const r of recs ?? []) {
                    cwdMap.set(String(r.header.id), r.header.cwd ?? null)
                  }
                } catch (err) {
                  log(`find(tasks) cwd lookup failed: ${errText(err)}`)
                }
              }

              out.tasks = picked.map((t) => {
                const kind = t.target?.kind ?? '?'
                let targetDesc = kind
                let cwd = null

                if (kind === 'session' && t.target.sessionId) {
                  const sid = String(t.target.sessionId)
                  cwd = cwdMap.get(sid) ?? null
                  targetDesc = `session:${sid}`
                } else if (kind === 'new_once' && t.target.sessionId) {
                  const sid = String(t.target.sessionId)
                  cwd = cwdMap.get(sid) ?? t.target.create?.cwd ?? null
                  targetDesc = `new_once:${sid}${cwd ? '' : '（未启动）'}`
                } else if (kind === 'new') {
                  cwd = t.target.create?.cwd ?? null
                  targetDesc = `new${cwd ? '' : '（未记录目录）'}`
                }

                let ws = '工作区未知'
                if (cwd && actor.cwd) ws = cwd === actor.cwd ? WORKSPACE_LABEL.current : WORKSPACE_LABEL.other
                const when = t.scheduledAt ? fmtLocal(Date.parse(t.scheduledAt)) : '?'
                const execActive = t.executionActive === true ? ' [执行中]' : ''

                return `${t.id} | ${t.title} | ${t.status}${execActive} | ${targetDesc} | ${ws}${cwd ? ' ' + cwd : ''} | next=${when}`
              })

              if (matched.length > limit) {
                out.message = `任务共 ${matched.length} 条匹配，仅显示前 ${limit} 条（还有 ${matched.length - limit} 条未显示）。`
              }
            }

            // ---------------- sessions ----------------
            if (mode === 'sessions' || mode === 'both') {
              const filters = [{ kind: 'availability', values: ['live', 'persisted'] }]
              if (!args.allow_cross_workspace && actor.cwd) {
                filters.push({ kind: 'cwd', values: [actor.cwd] })
              }
              const records = await sessionQuery.filterSessions(filters)

              // 从 projcache 补标题（异步 + 有界并发）
              const titles = await scanProjcacheTitles(projcacheDir)

              const merged = []
              for (const r of records ?? []) {
                const id = String(r.header.id)
                const origin = r.header.origin ?? 'user'
                if (isDelegatedHeader(r.header) && !includeSubagent) continue
                const meta = titles.get(id)
                const title = meta?.title ?? null
                if (!title && !includeUnnamed) continue
                merged.push({
                  id,
                  title: title ?? '(无标题)',
                  live: r.live,
                  persisted: r.persisted,
                  cwd: r.header.cwd ?? '-',
                  origin,
                  cacheUpdatedAt: meta?.cacheUpdatedAt ?? 0,
                  lastActiveAt: meta?.lastActiveAt ?? null,
                })
              }

              // 有真实 lastPromptAt 的按它排（最接近「最后活跃」），
              // 没有的退回文件 mtime；两者都缺的沉底。
              const sortKey = (s) => s.lastActiveAt ?? s.cacheUpdatedAt ?? 0
              merged.sort((a, b) => sortKey(b) - sortKey(a))

              out.totalNamed = titles.size

              const qfiltered = q ? merged.filter((s) => s.title.toLowerCase().includes(q)) : merged

              out.sessions = qfiltered.slice(0, limit).map((s) => {
                const active = s.lastActiveAt ? `lastActive=${fmtLocal(s.lastActiveAt)}` : 'lastActive=-'
                const cache = s.cacheUpdatedAt ? `cacheUpdated=${fmtLocal(s.cacheUpdatedAt)}` : ''
                return `${s.id} | ${s.title} | ${s.live ? 'live' : 'persisted'} | ${s.origin} | ${active}${cache ? ' ' + cache : ''} | cwd=${s.cwd}`
              })

              if (qfiltered.length > limit) {
                out.message += `会话共 ${qfiltered.length} 条匹配，仅显示前 ${limit} 条。`
              }
              if (q && qfiltered.length === 0) {
                out.message += `没有标题包含 "${args.query}" 的会话。`
              }
            }

            out.elapsedMs = Date.now() - started
            log(
              `find mode=${mode} q="${q}" tasks=${out.tasks.length} sessions=${out.sessions.length} named=${out.totalNamed} ${out.elapsedMs}ms`,
            )
            return out
          } catch (err) {
            log(`find failed: ${errText(err)}`)
            return {
              ok: false,
              tasks: [],
              sessions: [],
              totalNamed: 0,
              elapsedMs: Date.now() - started,
              message: errText(err),
            }
          }
        },
      })

      log('4 tools registered')
    })
  }
}
