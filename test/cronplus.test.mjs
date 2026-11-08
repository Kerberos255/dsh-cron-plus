/**
 * dsh-cron-plus 隔离回归测试
 *
 * 对应 DESIGN.md §11.4 的七类验收。全部用模拟的 Schedule / SessionQuery /
 * 文件系统，不接触真实 Scheduler、不触发任何生产任务、不改生产 schedule.json。
 *
 * 运行：
 *   node --test test/
 *
 * 设计要点：
 *   · 插件模块在加载时读取 DSH_HOME / CRONPLUS_LOG 环境变量，
 *     所以每个用例都要先设好环境、再动态 import 一份新模块。
 *   · Cordis 的 ctx.inject(deps, cb) 被模拟成同步回调，scope.get 按名字返回服务，
 *     scope.tools.register 把工具定义收集起来。
 *   · 只测插件自己的决策逻辑（拒绝/放行/回执/回读/不确定态分类），
 *     不测官方 Service 的行为。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// ------------------------------------------------------------
// 环境与工具
// ------------------------------------------------------------

let tmpRoot
let seq = 0

/** 每个用例一份独立的数据目录，避免互相污染 */
async function makeEnv() {
  const dir = path.join(tmpRoot, `case-${seq++}`)
  const projcache = path.join(dir, 'storages', 'session_projcache', 'sessions')
  await fsp.mkdir(projcache, { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { archivedSessionIds: [] },
      tables: { workspaces: {} },
    }),
    'utf8',
  )
  const logPath = path.join(dir, 'cron-plus.log')
  return { dir, projcache, logPath }
}

/** 写一个 projcache 文件（模拟投影结构） */
async function writeProjcache(projcache, sessionId, title, lastPromptAt) {
  const rows = {}
  if (title !== undefined) rows.title = title
  if (lastPromptAt !== undefined) rows.sessionListMetadata = { ver: 1, seq: 1, val: { lastPromptAt } }
  const body = { version: 1, record: { identity: {}, rows } }
  await fsp.writeFile(path.join(projcache, `${sessionId}.json`), JSON.stringify(body), 'utf8')
}

/** 构造一个 Session header */
function header(id, cwd, extra = {}) {
  return { version: 1, id, createdAt: Date.now(), cwd, isSeeded: false, ...extra }
}

/** 构造 SessionRecord */
function record(id, cwd, extra = {}) {
  return { header: header(id, cwd, extra), live: false, persisted: true }
}

/** 构造工具调用上下文 */
function makeExec(sessionId, cwd, extra = {}) {
  return {
    agent: { session: { id: sessionId, header: header(sessionId, cwd, extra) } },
    signal: undefined,
  }
}

/**
 * 加载一份插件实例，返回已注册的工具表。
 * 每次调用都会重新 import，确保环境变量在模块求值时生效。
 */
async function loadPlugin({ env, schedule, sessionQuery, useHostHome = false }) {
  const prevHome = process.env.DSH_HOME
  const prevLog = process.env.CRONPLUS_LOG
  if (useHostHome) delete process.env.DSH_HOME
  else process.env.DSH_HOME = env.dir
  process.env.CRONPLUS_LOG = env.logPath

  const mod = await import(`../index.js?case=${seq++}`)
  const CronPlus = mod.default

  const registered = []
  const tools = {
    register(def) {
      registered.push(def)
    },
  }

  const ctx = {
    dshHomePath(...parts) { return path.join(env.dir, ...parts) },
    inject(deps, cb) {
      const scope = {
        get(name) {
          if (name === 'schedule') return schedule
          if (name === 'sessionQuery') return sessionQuery
          if (name === 'tools') return tools
          return undefined
        },
      }
      // 插件内部用 scope.tools.register(...)，所以 scope 上也要挂 tools
      scope.tools = tools
      cb(scope)
    },
  }

  new CronPlus(ctx)

  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  if (prevLog === undefined) delete process.env.CRONPLUS_LOG
  else process.env.CRONPLUS_LOG = prevLog

  const byName = new Map(registered.map((d) => [d.name, d]))
  return { tools: registered, byName }
}

/** 一个可控的 Schedule 模拟：记录调用、按脚本返回或抛错 */
function makeSchedule(script = {}) {
  const calls = []
  const defaults = {
    create: async (input) => ({
      id: 'schedule-new',
      title: input.title,
      target: input.target,
      scheduledAt: '2027-01-01T01:00:00.000Z',
      status: 'active',
    }),
    view: async ({ id }) => ({
      id,
      title: 'T',
      prompt: 'P',
      status: 'active',
      target: { kind: 'session', sessionId: 'session-x' },
      updatedAt: '2026-11-08T00:00:00.000Z',
      scheduledAt: '2027-01-01T01:00:00.000Z',
    }),
    catalog: async () => [],
    edit: async (input) => ({
      id: input.id,
      status: 'active',
      target: { kind: 'session', sessionId: 'session-x' },
      scheduledAt: '2027-01-01T01:00:00.000Z',
    }),
    run: async (input) => ({
      id: input.id,
      target: { kind: 'session', sessionId: 'session-x' },
      scheduledAt: '2027-01-01T01:00:00.000Z',
      title: 'T',
    }),
  }
  const impl = { ...defaults, ...script }
  const service = {}
  // 统一包裹：无论某个方法是否被 script 覆盖，调用都记进 calls
  for (const [name, fn] of Object.entries(impl)) {
    service[name] = async (...args) => {
      calls.push({ op: name, args })
      return fn(...args)
    }
  }
  service.calls = calls
  return service
}

/** 一个可控的 SessionQuery 模拟 */
function makeSessionQuery(records = [], opts = {}) {
  return {
    async listSessions() {
      return records
    },
    async filterSessions(filters) {
      if (opts.filterSessions) return opts.filterSessions(filters, records)
      // 简化实现：只处理 id 与 cwd 两种过滤
      let out = records
      for (const f of filters ?? []) {
        if (f.kind === 'id') out = out.filter((r) => f.values.includes(String(r.header.id)))
        else if (f.kind === 'cwd') out = out.filter((r) => f.values.includes(r.header.cwd))
      }
      return out
    },
    async readTitleSnapshots() {
      return new Map()
    },
  }
}

/** 错误构造：模拟官方 ScheduleInputError */
function inputError(code, msg) {
  const e = new Error(msg)
  e.name = 'ScheduleInputError'
  e.code = code
  return e
}

// ------------------------------------------------------------
// 生命周期
// ------------------------------------------------------------

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cronplus-test-'))
})

after(async () => {
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true })
})

const CWD = '/virtual/workspace-one'
const OTHER_CWD = '/virtual/workspace-two'

// ============================================================
// 1. 跨工作区 run / find
// ============================================================

describe('1. 跨工作区 run / find', () => {
  test('find(tasks) 区分当前/其他工作区，并输出完整 Session ID', async () => {
    const env = await makeEnv()
    const localRec = record('session-local-aaaa', CWD)
    const otherRec = record('session-other-bbbb', OTHER_CWD)
    const schedule = makeSchedule({
      catalog: async () => [
        {
          id: 'schedule-1',
          title: '本区任务',
          status: 'active',
          target: { kind: 'session', sessionId: 'session-local-aaaa' },
          scheduledAt: '2027-01-01T01:00:00.000Z',
        },
        {
          id: 'schedule-2',
          title: '外区任务',
          status: 'active',
          target: { kind: 'session', sessionId: 'session-other-bbbb' },
          scheduledAt: '2027-01-01T02:00:00.000Z',
        },
        {
          id: 'schedule-3',
          title: '新建任务',
          status: 'active',
          target: { kind: 'new', create: { cwd: OTHER_CWD } },
          scheduledAt: '2027-01-01T03:00:00.000Z',
        },
      ],
    })
    const sq = makeSessionQuery([localRec, otherRec])
    const { byName } = await loadPlugin({ env, schedule, sessionQuery: sq })

    const out = await byName.get('cronplus_find').execute({ mode: 'tasks', limit: 10 }, makeExec('session-cur', CWD))
    assert.equal(out.ok, true)
    assert.equal(out.tasks.length, 3)

    const [t1, t2, t3] = out.tasks
    assert.match(t1, /当前工作区/)
    assert.match(t1, /session-local-aaaa/)
    assert.match(t2, /其他工作区/)
    // 完整 ID，不是截短
    assert.match(t2, /session-other-bbbb/)
    assert.doesNotMatch(t2, /\.\.\./)
    // new 目标用 create.cwd
    assert.match(t3, /其他工作区/)
    assert.match(t3, new RegExp(OTHER_CWD.replace(/\\/g, '\\\\')))
  })

  test('run 允许跨工作区，但回执标明归属且计划时刻不变', async () => {
    const env = await makeEnv()
    const otherRec = record('session-other-bbbb', OTHER_CWD)
    const schedule = makeSchedule({
      view: async () => ({
        id: 'schedule-2',
        title: '外区任务',
        status: 'active',
        target: { kind: 'session', sessionId: 'session-other-bbbb' },
        scheduledAt: '2027-01-01T02:00:00.000Z',
      }),
    })
    const sq = makeSessionQuery([otherRec])
    const { byName } = await loadPlugin({ env, schedule, sessionQuery: sq })

    const out = await byName.get('cronplus_run').execute({ id: 'schedule-2' }, makeExec('session-cur', CWD))
    assert.equal(out.result, 'delivered')
    assert.equal(out.workspace, '其他工作区')
    assert.equal(out.targetSession, 'session-other-bbbb')
    // run 不应有编辑动作
    assert.equal(schedule.calls.filter((c) => c.op === 'edit').length, 0)
  })

  test('run 预读异常不能误报任务不存在，也不能真正触发', async () => {
    const env = await makeEnv()
    const schedule = makeSchedule({ view: async () => { throw new Error('temporary read outage') } })
    const { byName } = await loadPlugin({ env, schedule, sessionQuery: makeSessionQuery([]) })
    const result = await byName.get('cronplus_run').execute({ id: 'schedule-x' }, makeExec('cur', CWD))
    assert.equal(result.result, 'failed')
    assert.match(result.message, /尚未触发执行/)
    assert.equal(schedule.calls.filter(c => c.op === 'run').length, 0)
  })

  test('run 去重：not_found / pending 分别映射', async () => {
    const env = await makeEnv()

    // not_found：view 就查不到
    {
      const schedule = makeSchedule({
        view: async () => ({ id: 'x', code: 'schedule_not_found' }),
      })
      const { byName } = await loadPlugin({
        env: await makeEnv(),
        schedule,
        sessionQuery: makeSessionQuery([]),
      })
      const out = await byName.get('cronplus_run').execute({ id: 'x' }, makeExec('s', CWD))
      assert.equal(out.result, 'not_found')
    }

    // pending：run 返回 execution_pending
    {
      const schedule = makeSchedule({
        run: async () => ({ id: 'x', code: 'schedule_execution_pending' }),
      })
      const { byName } = await loadPlugin({
        env: await makeEnv(),
        schedule,
        sessionQuery: makeSessionQuery([]),
      })
      const out = await byName.get('cronplus_run').execute({ id: 'x' }, makeExec('s', CWD))
      assert.equal(out.result, 'pending')
    }
  })
})

// ============================================================
// 2. 跨工作区 rebind
// ============================================================

describe('2. 跨工作区 rebind', () => {
  test('默认拒绝跨工作区改绑', async () => {
    const env = await makeEnv()
    const otherRec = record('session-other-bbbb', OTHER_CWD)
    const schedule = makeSchedule()
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([otherRec]),
    })

    const out = await byName
      .get('cronplus_edit')
      .execute({ id: 'schedule-1', action: 'rebind', target_session_id: 'session-other-bbbb' }, makeExec('cur', CWD))
    assert.equal(out.state, 'failed')
    assert.match(out.message, /cronplus_cross_workspace/)
    // 没有真正调用 edit
    assert.equal(schedule.calls.filter((c) => c.op === 'edit').length, 0)
  })

  test('显式 allow_cross_workspace=true 时允许改绑，并回读确认', async () => {
    const env = await makeEnv()
    const otherRec = record('session-other-bbbb', OTHER_CWD)
    let rereadTarget = 'session-other-bbbb'
    const schedule = makeSchedule({
      view: async () => ({
        id: 'schedule-1',
        title: 'T',
        status: 'active',
        target: { kind: 'session', sessionId: rereadTarget },
        updatedAt: '2026-11-08T00:00:00.000Z',
        scheduledAt: '2027-01-01T01:00:00.000Z',
      }),
      edit: async (input) => ({
        id: input.id,
        status: 'active',
        target: { kind: 'session', sessionId: 'session-other-bbbb' },
        scheduledAt: '2027-01-01T01:00:00.000Z',
      }),
    })
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([otherRec]),
    })

    const out = await byName.get('cronplus_edit').execute(
      { id: 'schedule-1', action: 'rebind', target_session_id: 'session-other-bbbb', allow_cross_workspace: true },
      makeExec('cur', CWD),
    )
    assert.equal(out.state, 'updated')
    assert.equal(out.verified, true)

    // 两种情况 view 都应被调用：读旧目标 + 回读
    assert.ok(schedule.calls.filter((c) => c.op === 'view').length >= 2)
  })
})

// ============================================================
// 3. 旧目标类型与归档
// ============================================================

describe('3. 旧目标类型与归档', () => {
  test('pause 一个目标已归档的任务：不因旧目标失效而拒绝', async () => {
    const env = await makeEnv()
    // 把旧目标标为归档
    await fsp.writeFile(
      path.join(env.dir, 'storages', 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { archivedSessionIds: ['session-archived-cccc'] },
        tables: { workspaces: {} },
      }),
      'utf8',
    )
    const archivedRec = record('session-archived-cccc', CWD)
    const schedule = makeSchedule({
      view: async () => ({
        id: 'schedule-3',
        title: 'T',
        status: 'active',
        target: { kind: 'session', sessionId: 'session-archived-cccc' },
        updatedAt: '2026-11-08T00:00:00.000Z',
        scheduledAt: '2027-01-01T01:00:00.000Z',
      }),
      edit: async (input) => ({
        id: input.id,
        status: 'paused',
        target: { kind: 'session', sessionId: 'session-archived-cccc' },
        scheduledAt: '2027-01-01T01:00:00.000Z',
      }),
    })
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([archivedRec]),
    })

    const out = await byName.get('cronplus_edit').execute({ id: 'schedule-3', action: 'pause' }, makeExec('cur', CWD))
    assert.equal(out.state, 'updated', '归档旧目标不应阻止 pause')
    assert.equal(schedule.calls.filter((c) => c.op === 'edit').length, 1)
  })

  test('old target = new：pause 正常，归属标未知或按 create.cwd', async () => {
    const env = await makeEnv()
    const schedule = makeSchedule({
      view: async () => ({
        id: 'schedule-4',
        title: 'T',
        status: 'active',
        target: { kind: 'new' },
        updatedAt: '2026-11-08T00:00:00.000Z',
        scheduledAt: '2027-01-01T01:00:00.000Z',
      }),
      edit: async (input) => ({
        id: input.id,
        status: 'paused',
        target: { kind: 'new' },
        scheduledAt: '2027-01-01T01:00:00.000Z',
      }),
    })
    const { byName } = await loadPlugin({ env, schedule, sessionQuery: makeSessionQuery([]) })

    const out = await byName.get('cronplus_edit').execute({ id: 'schedule-4', action: 'pause' }, makeExec('cur', CWD))
    assert.equal(out.state, 'updated')
    assert.match(out.oldTarget, /工作区未知|其他工作区|当前工作区/)
  })

  test('create 目标已归档 → 确定失败，中文原因', async () => {
    const env = await makeEnv()
    await fsp.writeFile(
      path.join(env.dir, 'storages', 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { archivedSessionIds: ['session-archived-cccc'] },
        tables: { workspaces: {} },
      }),
      'utf8',
    )
    const schedule = makeSchedule()
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([record('session-archived-cccc', CWD)]),
    })

    const out = await byName.get('cronplus_create').execute(
      { title: 'x', prompt: 'y', rrule: 'z', target_session_id: 'session-archived-cccc' },
      makeExec('cur', CWD),
    )
    assert.equal(out.state, 'failed')
    assert.match(out.message, /cronplus_target_archived|已归档/)
    assert.equal(schedule.calls.filter((c) => c.op === 'create').length, 0)
  })
})

// ============================================================
// 4. 不确定态 / 并发
// ============================================================

describe('4. 不确定态与并发', () => {
  test('create 遇到非输入类错误 → state=unknown，且不自动重试', async () => {
    const env = await makeEnv()
    let createCalls = 0
    const schedule = makeSchedule({
      create: async (input) => {
        createCalls++
        const e = new Error('socket hang up')
        e.code = 'ECONNRESET'
        throw e
      },
      catalog: async () => [],
    })
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([record('session-t', CWD)]),
    })

    const out = await byName.get('cronplus_create').execute(
      { title: 'x', prompt: 'y', rrule: 'z', target_session_id: 'session-t' },
      makeExec('cur', CWD),
    )
    assert.equal(out.state, 'unknown')
    assert.equal(out.retryable, false)
    assert.equal(createCalls, 1, '不能自动重试')
    // 应做过只读核对
    assert.ok(schedule.calls.some((c) => c.op === 'catalog'))
  })

  test('create 的 schedule/unknown-state 是回执不确定，不可谎报确认未写入', async () => {
    const env = await makeEnv()
    const schedule = makeSchedule({
      create: async () => { throw inputError('schedule/unknown-state', 'write may have committed') },
      catalog: async () => [],
    })
    const { byName } = await loadPlugin({ env, schedule, sessionQuery: makeSessionQuery([record('session-t', CWD)]) })
    const result = await byName.get('cronplus_create').execute(
      { title: 'x', prompt: 'y', rrule: 'z', target_session_id: 'session-t' },
      makeExec('cur', CWD),
    )
    assert.equal(result.state, 'unknown')
    assert.equal(result.retryable, false)
    assert.equal(schedule.calls.filter(c => c.op === 'create').length, 1)
    assert.equal(schedule.calls.filter(c => c.op === 'catalog').length, 1)
  })

  test('create 遇到 ScheduleInputError → 确定失败，不核对', async () => {
    const env = await makeEnv()
    const schedule = makeSchedule({
      create: async () => {
        throw inputError('invalid_rule', 'rrule is invalid')
      },
    })
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([record('session-t', CWD)]),
    })

    const out = await byName.get('cronplus_create').execute(
      { title: 'x', prompt: 'y', rrule: 'bad', target_session_id: 'session-t' },
      makeExec('cur', CWD),
    )
    assert.equal(out.state, 'failed')
    assert.match(out.message, /invalid_rule/)
    // 确定失败不做 catalog 核对
    assert.equal(schedule.calls.filter((c) => c.op === 'catalog').length, 0)
  })

  test('create 的 schedule/input-invalid 是确定输入失败', async () => {
    const env = await makeEnv()
    const schedule = makeSchedule({
      create: async () => { throw inputError('schedule/input-invalid', 'invalid rule') },
    })
    const { byName } = await loadPlugin({ env, schedule, sessionQuery: makeSessionQuery([record('session-t', CWD)]) })
    const result = await byName.get('cronplus_create').execute(
      { title: 'x', prompt: 'y', rrule: 'bad', target_session_id: 'session-t' },
      makeExec('cur', CWD),
    )
    assert.equal(result.state, 'failed')
    assert.equal(schedule.calls.filter(c => c.op === 'catalog').length, 0)
  })

  test('create 不确定时能找到疑似已创建条目', async () => {
    const env = await makeEnv()
    const now = Date.now()
    const schedule = makeSchedule({
      create: async () => {
        throw new Error('timeout')
      },
      catalog: async () => [
        {
          id: 'schedule-suspect',
          title: 'x',
          prompt: 'y',
          status: 'active',
          target: { kind: 'session', sessionId: 'session-t' },
          createdAt: new Date(now).toISOString(),
          scheduledAt: '2027-01-01T01:00:00.000Z',
        },
      ],
    })
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([record('session-t', CWD)]),
    })

    const out = await byName.get('cronplus_create').execute(
      { title: 'x', prompt: 'y', rrule: 'z', target_session_id: 'session-t' },
      makeExec('cur', CWD),
    )
    assert.equal(out.state, 'unknown')
    assert.ok(out.suspects.some((s) => s.includes('schedule-suspect')))
  })

  test('edit 冲突时不强行覆盖', async () => {
    const env = await makeEnv()
    const schedule = makeSchedule({
      edit: async () => ({ id: 'schedule-1', code: 'schedule_conflict' }),
    })
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([record('session-x', CWD)]),
    })

    const out = await byName.get('cronplus_edit').execute({ id: 'schedule-1', action: 'pause' }, makeExec('cur', CWD))
    assert.equal(out.state, 'conflict')
    // 只调用一次 edit，不重试
    assert.equal(schedule.calls.filter((c) => c.op === 'edit').length, 1)
  })

  test('edit 回读失败 → verified=false，报「已提交但未确认」', async () => {
    const env = await makeEnv()
    let viewCalls = 0
    const schedule = makeSchedule({
      view: async () => {
        viewCalls++
        if (viewCalls === 1) {
          return {
            id: 'schedule-1',
            title: 'T',
            status: 'active',
            target: { kind: 'session', sessionId: 'session-x' },
            updatedAt: '2026-11-08T00:00:00.000Z',
            scheduledAt: '2027-01-01T01:00:00.000Z',
          }
        }
        throw new Error('readback failed')
      },
    })
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([record('session-x', CWD)]),
    })

    const out = await byName.get('cronplus_edit').execute({ id: 'schedule-1', action: 'pause' }, makeExec('cur', CWD))
    assert.equal(out.state, 'updated')
    assert.equal(out.verified, false)
    assert.match(out.message, /回读|未确认/)
  })
})

// ============================================================
// 5. 委派
// ============================================================

describe('5. 委派限制', () => {
  const delegatedCases = [
    ['origin=subagent', { origin: 'subagent' }],
    ['delegationDepth>0', { delegationDepth: 2 }],
  ]

  for (const [label, extra] of delegatedCases) {
    test(`${label} 时拒绝 create`, async () => {
      const env = await makeEnv()
      const schedule = makeSchedule()
      const { byName } = await loadPlugin({
        env,
        schedule,
        sessionQuery: makeSessionQuery([record('session-t', CWD)]),
      })

      const out = await byName.get('cronplus_create').execute(
        { title: 'x', prompt: 'y', rrule: 'z', target_session_id: 'session-t' },
        makeExec('sub', CWD, extra),
      )
      // 必须是确定失败，不能是 unknown
      assert.equal(out.state, 'failed', `${label} 应判为确定失败`)
      assert.match(out.message, /cronplus_delegated/)
      assert.equal(schedule.calls.filter((c) => c.op === 'create').length, 0)
    })
  }

  test('委派拒绝时不做无谓的 catalog 核对', async () => {
    const env = await makeEnv()
    const schedule = makeSchedule()
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([record('session-t', CWD)]),
    })

    await byName.get('cronplus_create').execute(
      { title: 'x', prompt: 'y', rrule: 'z', target_session_id: 'session-t' },
      makeExec('sub', CWD, { origin: 'subagent' }),
    )
    assert.equal(schedule.calls.filter((c) => c.op === 'catalog').length, 0)
  })

  test('根会话不被委派规则误伤', async () => {
    const env = await makeEnv()
    const schedule = makeSchedule()
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([record('session-t', CWD)]),
    })

    const out = await byName.get('cronplus_create').execute(
      { title: 'x', prompt: 'y', rrule: 'z', target_session_id: 'session-t' },
      makeExec('root', CWD), // 没有 origin / delegationDepth
    )
    assert.equal(out.state, 'created')
  })

  test('fork 出来的普通会话（有 parentSession 但无 subagent 标记）不被拒绝', async () => {
    const env = await makeEnv()
    const schedule = makeSchedule()
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([record('session-t', CWD)]),
    })

    const out = await byName.get('cronplus_create').execute(
      { title: 'x', prompt: 'y', rrule: 'z', target_session_id: 'session-t' },
      makeExec('forked', CWD, { parentSession: 'session-parent' }),
    )
    assert.equal(out.state, 'created', '仅 parentSession 不应被判为子代理')
  })
})

// ============================================================
// 6. 查询与性能
// ============================================================

describe('6. 查询与性能', () => {
  test('find(sessions) 读标题、区分 lastActive 与 cacheUpdated', async () => {
    const env = await makeEnv()
    const lastActive = Date.parse('2026-11-08T13:00:00.000Z')
    await writeProjcache(env.projcache, 'session-named-1', '飞书-新闻', lastActive)
    await writeProjcache(env.projcache, 'session-unnamed', undefined, undefined)

    const schedule = makeSchedule()
    const sq = makeSessionQuery([
      record('session-named-1', CWD),
      record('session-unnamed', CWD),
    ])
    const { byName } = await loadPlugin({ env, schedule, sessionQuery: sq })

    const out = await byName.get('cronplus_find').execute({ mode: 'sessions' }, makeExec('cur', CWD))
    assert.equal(out.ok, true)
    // 默认不列无标题
    assert.equal(out.sessions.length, 1)

    const line = out.sessions[0]
    assert.match(line, /飞书-新闻/)
    assert.match(line, /lastActive=/)
    // lastActive 应是 21:00（北京时间，13:00Z + 8h）
    assert.match(line, /lastActive=11-08 21:00/)
  })

  test('无需 DSH_HOME 环境变量时通过宿主 dshHomePath 发现数据目录', async () => {
    const env = await makeEnv()
    await writeProjcache(env.projcache, 'session-host-home', '宿主路径标题', Date.now())
    const { byName } = await loadPlugin({
      env,
      schedule: makeSchedule(),
      sessionQuery: makeSessionQuery([record('session-host-home', CWD)]),
      useHostHome: true,
    })
    const out = await byName.get('cronplus_find').execute({ mode: 'sessions' }, makeExec('cur', CWD))
    assert.equal(out.ok, true)
    assert.equal(out.sessions.length, 1)
    assert.match(out.sessions[0], /宿主路径标题/)
  })

  test('find(sessions) include_unnamed 时列出无标题会话', async () => {
    const env = await makeEnv()
    await writeProjcache(env.projcache, 'session-named-1', '有名字', Date.now())
    // 无 title 的文件也要能扫到（不报错）
    await fsp.writeFile(
      path.join(env.projcache, 'session-unnamed.json'),
      JSON.stringify({ version: 1, record: { identity: {}, rows: {} } }),
      'utf8',
    )

    const { byName } = await loadPlugin({
      env,
      schedule: makeSchedule(),
      sessionQuery: makeSessionQuery([record('session-named-1', CWD), record('session-unnamed', CWD)]),
    })

    const out = await byName
      .get('cronplus_find')
      .execute({ mode: 'sessions', include_unnamed: true }, makeExec('cur', CWD))
    assert.equal(out.sessions.length, 2)
    assert.ok(out.sessions.some((s) => s.includes('(无标题)')))
  })

  test('find(sessions) 排除委派子代理会话', async () => {
    const env = await makeEnv()
    await writeProjcache(env.projcache, 'session-sub', '子代理会话', Date.now())
    await writeProjcache(env.projcache, 'session-ok', '正常会话', Date.now())

    const { byName } = await loadPlugin({
      env,
      schedule: makeSchedule(),
      sessionQuery: makeSessionQuery([
        record('session-sub', CWD, { origin: 'subagent' }),
        record('session-ok', CWD),
      ]),
    })

    const out = await byName.get('cronplus_find').execute({ mode: 'sessions' }, makeExec('cur', CWD))
    assert.equal(out.sessions.length, 1)
    assert.match(out.sessions[0], /正常会话/)
  })

  test('损坏的 projcache 文件不影响其他会话', async () => {
    const env = await makeEnv()
    await writeProjcache(env.projcache, 'session-good', '好会话', Date.now())
    await fsp.writeFile(path.join(env.projcache, 'session-broken.json'), '{ not valid json', 'utf8')

    const { byName } = await loadPlugin({
      env,
      schedule: makeSchedule(),
      sessionQuery: makeSessionQuery([record('session-good', CWD), record('session-broken', CWD)]),
    })

    const out = await byName.get('cronplus_find').execute({ mode: 'sessions' }, makeExec('cur', CWD))
    assert.equal(out.ok, true)
    assert.equal(out.sessions.length, 1)
  })

  test('标题含引号与 Unicode 时正确解码', async () => {
    const env = await makeEnv()
    const tricky = '他说"你好"👋 测试'
    await writeProjcache(env.projcache, 'session-tricky', tricky, Date.now())

    const { byName } = await loadPlugin({
      env,
      schedule: makeSchedule(),
      sessionQuery: makeSessionQuery([record('session-tricky', CWD)]),
    })

    const out = await byName.get('cronplus_find').execute({ mode: 'sessions' }, makeExec('cur', CWD))
    assert.equal(out.sessions.length, 1)
    assert.match(out.sessions[0], /他说"你好"👋 测试/)
  })

  test('find(tasks) 同名任务按完整 ID 区分', async () => {
    const env = await makeEnv()
    const schedule = makeSchedule({
      catalog: async () => [
        { id: 'schedule-a', title: '同名', status: 'active', target: { kind: 'session', sessionId: 'session-1' }, scheduledAt: '2027-01-01T01:00:00.000Z' },
        { id: 'schedule-b', title: '同名', status: 'active', target: { kind: 'session', sessionId: 'session-2' }, scheduledAt: '2027-01-01T02:00:00.000Z' },
      ],
    })
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([record('session-1', CWD), record('session-2', CWD)]),
    })

    const out = await byName.get('cronplus_find').execute({ mode: 'tasks' }, makeExec('cur', CWD))
    assert.equal(out.tasks.length, 2)
    assert.ok(out.tasks[0].startsWith('schedule-a'))
    assert.ok(out.tasks[1].startsWith('schedule-b'))
    assert.ok(out.tasks[0].includes('session-1'))
    assert.ok(out.tasks[1].includes('session-2'))
  })

  test('find(tasks) 超限时说明还有更多', async () => {
    const env = await makeEnv()
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: `schedule-${i}`,
      title: `任务${i}`,
      status: 'active',
      target: { kind: 'session', sessionId: 'session-1' },
      scheduledAt: '2027-01-01T01:00:00.000Z',
    }))
    const { byName } = await loadPlugin({
      env,
      schedule: makeSchedule({ catalog: async () => items }),
      sessionQuery: makeSessionQuery([record('session-1', CWD)]),
    })

    const out = await byName.get('cronplus_find').execute({ mode: 'tasks', limit: 2 }, makeExec('cur', CWD))
    assert.equal(out.tasks.length, 2)
    assert.match(out.message, /还有 3 条/)
  })
})

// ============================================================
// 7. 兼容与卸载（工具表）
// ============================================================

describe('7. 工具表与兼容', () => {
  test('注册且只注册四个工具，名字固定', async () => {
    const env = await makeEnv()
    const { tools } = await loadPlugin({
      env,
      schedule: makeSchedule(),
      sessionQuery: makeSessionQuery([]),
    })
    const names = tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['cronplus_create', 'cronplus_edit', 'cronplus_find', 'cronplus_run'])
  })

  test('每个工具都有 parameters 与 output.schema', async () => {
    const env = await makeEnv()
    const { tools } = await loadPlugin({
      env,
      schedule: makeSchedule(),
      sessionQuery: makeSessionQuery([]),
    })
    for (const t of tools) {
      assert.ok(t.parameters, `${t.name} 缺 parameters`)
      assert.equal(t.parameters.type, 'object')
      assert.ok(t.output?.schema, `${t.name} 缺 output.schema`)
      assert.equal(typeof t.execute, 'function')
      assert.equal(typeof t.output.render, 'function')
    }
  })

  test('edit 的 action 枚举只有三个值', async () => {
    const env = await makeEnv()
    const { byName } = await loadPlugin({
      env,
      schedule: makeSchedule(),
      sessionQuery: makeSessionQuery([]),
    })
    const edit = byName.get('cronplus_edit')
    assert.deepEqual(edit.parameters.properties.action.enum, ['rebind', 'pause', 'resume'])
    // 不接受未声明的属性
    assert.equal(edit.parameters.additionalProperties, false)
  })

  test('rebind 之外传 target_session_id 会被拒绝', async () => {
    const env = await makeEnv()
    const schedule = makeSchedule()
    const { byName } = await loadPlugin({
      env,
      schedule,
      sessionQuery: makeSessionQuery([record('session-x', CWD)]),
    })

    const out = await byName
      .get('cronplus_edit')
      .execute({ id: 'schedule-1', action: 'pause', target_session_id: 'session-x' }, makeExec('cur', CWD))
    assert.equal(out.state, 'failed')
    assert.match(out.message, /cronplus_bad_target/)
  })
})
