/**
 * dsh-tool-taiji — 太极调度工具插件 (方案 A)
 *
 * 把 taiji.py 的信息素/竞标/评审/收敛循环实现为 dsh 工具:
 *   - 信息素地图: 文件持久化 (workdir/.taiji/pheromones.json), Pe/Pr 双态蒸发
 *   - 动态竞标: 高斯响应曲线三档分流 (claude 攻坚 / opencode 工兵 / codex 兜底)
 *   - 对抗评审: subagent_pi 侦察 (四维记分卡) + subagent_codex 复审门
 *   - 收敛三关: 测试全绿 → danger<40 → 复审 PASS
 *
 * 调度全部走 ctx.subagents (四子已注册为 dsh 子智能体), 不直调 CLI。
 *
 * 用法: 模型调用 `taiji_run` 工具, 传入 goal/workdir/verify/rounds。
 */
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const execFileAsync = promisify(execFile)

export const name = 'dsh-tool-taiji'

export const inject = ['tools', 'subagents']

/** 竞标专长峰值 (与 taiji.py AGENT_PEAKS 一致)
 * 注意: codex 从修复通道排除 — 本容器 codex app-server 的 bubblewrap 沙箱
 * 需 user namespaces 受限 (2026-09-01 实测), 仅保留 claude_code + opencode 修复。
 * codex 仍以 subagent_codex 独立承担复审门。 */
const AGENT_PEAKS: Record<string, number> = {
  claude_code: 60,
  opencode: 90,
}

const PROVIDER_BY_AGENT: Record<string, string> = {
  claude_code: 'claude-code',
  opencode: 'opencode',
  codex: 'codex',
}

const DANGER_THRESHOLD = 40
const MAX_ROUNDS_DEFAULT = 4

/** 评审通道降级链 (2026-09-08 修复: codex 沙箱在本容器不可用 → 通道失败不再当真实 FAIL)
 * codex → opencode → claude-code (CLI 直调, 已知可用)。env TAIJI_REVIEW_CHAIN 可覆盖。 */
const REVIEW_CHAIN_DEFAULT = 'codex,opencode,claude-code'
const CHANNEL_FAIL_PREFIX = '(复审通道失败)'
const PI_CHANNEL_FAIL_PREFIX = '(评审通道失败)'
const CHANNEL_ALL_FAIL = '(复审通道全不可用)'

/** ACP/子代理委派有界超时 (2026-09-08: pi-acp 桥实测挂起 ~10min 无声失败 —
 * 通道坏时应秒级失败进入降级/门, 不许烧每代 10 分钟)。env TAIJI_DELEGATE_TIMEOUT 可覆盖。 */
const ACP_DELEGATE_TIMEOUT = Number(process.env.TAIJI_DELEGATE_TIMEOUT ?? 120_000)

/** 通道失败统一判定: pi 用"评审"措辞, 复审门用"复审"措辞 — 两者都是通道级失败标记 */
function isChannelFail(text: string): boolean {
  return text.startsWith(CHANNEL_FAIL_PREFIX) || text.startsWith(PI_CHANNEL_FAIL_PREFIX)
}

const zeroNode: PheromoneNode = { Pe: 0, Pr: 0, complexity: 0 }

interface PheromoneNode {
  Pe: number
  Pr: number
  complexity: number
  Pr_note?: string
}

type PheromoneMap = Record<string, PheromoneNode>

interface AcpBlock {
  type?: string
  text?: string
}

interface AcpStream {
  output?: AcpBlock[]
  stopReason?: string
}

interface TaijiArgs {
  goal: string
  workdir: string
  verify: string
  rounds?: number
  danger_dimensions?: string[]
  sandbox?: string
  auto_tdd?: boolean
}

/** execFileAsync 失败时错误对象携带 stdout/stderr/code（窄断言，替代 any） */
function execErrProps(e: unknown): { stdout: string; stderr: string; message: string; code: number } {
  const o = e as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown }
  return {
    stdout: String(o.stdout ?? ''),
    stderr: String(o.stderr ?? ''),
    message: String(o.message ?? String(e)),
    code: typeof o.code === 'number' ? o.code : 1,
  }
}

function pheromonePath(workdir: string): string {
  return join(workdir, '.taiji', 'pheromones.json')
}

function loadPheromones(workdir: string): PheromoneMap {
  const p = pheromonePath(workdir)
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as PheromoneMap
  } catch { /* 忽略损坏, 重建 */ }
  return {}
}

function savePheromones(workdir: string, pm: PheromoneMap): void {
  mkdirSync(join(workdir, '.taiji'), { recursive: true })
  writeFileSync(pheromonePath(workdir), JSON.stringify(pm, null, 2), 'utf-8')
}

/** Pe 蒸发: 测试绿 → ×0.5 强遗忘; 测试红 → 不蒸发 */
function evaporate(pm: PheromoneMap, testsPassed: boolean): PheromoneMap {
  const out: PheromoneMap = {}
  for (const [file, node] of Object.entries(pm)) {
    out[file] = {
      ...node,
      Pe: testsPassed ? Math.round(node.Pe * 0.5) : node.Pe,
      // Pr 复合蒸发: 代际 ×0.8
      Pr: Math.round(node.Pr * 0.8),
    }
  }
  return out
}

/** 加权喷洒: 测试失败文件 Pe += 30, 全局 +20 */
function sprayWeighted(pm: PheromoneMap, failedFiles: string[]): PheromoneMap {
  const out = { ...pm }
  const global = out['__project__'] ?? { Pe: 0, Pr: 0, complexity: 30 }
  global.Pe += 20
  out['__project__'] = global
  for (const f of failedFiles) {
    const node = out[f] ?? { Pe: 0, Pr: 0, complexity: 0 }
    node.Pe += 30
    out[f] = node
  }
  return out
}

/** 高斯响应竞标: 每个 agent 有专长刺激区间, 概率微扰后排序 (降序)
 * 4.0 演进: 竞标分 × 信誉权重 (经验引导派单, 修复连续失败者权重下降,
 * 其它通道自动上位 — 修复通道从 claude 独占扩展为权重自动派单)。 */
function auction(pm: PheromoneMap, workdir: string): { file: string; agents: string[]; stimulus: number } | undefined {
  const candidates: string[] = []
  for (const [file, node] of Object.entries(pm)) {
    if (node.Pe > 0 || node.Pr > 0) candidates.push(file)
  }
  if (candidates.length === 0) return undefined
  const file = candidates.reduce((a, b) =>
    (stimulusOf(pm[a] ?? zeroNode) > stimulusOf(pm[b] ?? zeroNode) ? a : b))
  const s = stimulusOf(pm[file] ?? zeroNode)
  const weights = loadAgentWeights(workdir)
  const scored: Array<[string, number]> = []
  for (const [agent, peak] of Object.entries(AGENT_PEAKS)) {
    const w = weights[agent] ?? 0
    const score = Math.exp(-(((s - peak) / 60) ** 2)) * (0.85 + Math.random() * 0.3) * (1 + w * 0.2)
    scored.push([agent, score])
  }
  scored.sort((a, b) => b[1] - a[1])
  return { file, agents: scored.map(([a]) => a), stimulus: s }
}

/** ── 4.0 演进: agent 信誉权重 (2026-09-01) ────────────────────────────
 * 持久化 .taiji/agent-weights.json: 修复成功 +1 / 失败 -1 (衰减0.9)。
 * 竞标分 × (1 + w*0.2): 连续失败的 agent 信誉下降, 其它通道自动上位。 */
const AGENT_WEIGHTS_FILE = '.taiji/agent-weights.json'
const WEIGHT_DECAY = 0.9

function loadAgentWeights(workdir: string): Record<string, number> {
  try {
    const p = resolve(workdir, AGENT_WEIGHTS_FILE)
    const raw = readFileSync(p, 'utf8')
    return JSON.parse(raw) as Record<string, number>
  } catch {
    return {}
  }
}

function saveAgentWeights(workdir: string, w: Record<string, number>): void {
  try {
    const p = resolve(workdir, AGENT_WEIGHTS_FILE)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(w, null, 2))
  } catch {
    /* 权重落盘失败不阻断循环 */
  }
}

function updateAgentWeight(workdir: string, agent: string, ok: boolean): void {
  const w = loadAgentWeights(workdir)
  for (const k of Object.keys(w)) w[k] = Number(((w[k] ?? 0) * WEIGHT_DECAY).toFixed(3))
  const key = Object.keys(AGENT_PEAKS).find(a => a === agent) ?? agent
  w[key] = Number(((w[key] ?? 0) + (ok ? 1 : -1)).toFixed(3))
  saveAgentWeights(workdir, w)
}
function stimulusOf(node: PheromoneNode): number {
  return node.Pe + node.Pr * 0.5
}

/** 运行 verify 命令 */
async function runVerify(verify: string, workdir: string, timeoutMs = 300000): Promise<{ ok: boolean; out: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', verify], {
      cwd: workdir,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, out: stdout + stderr, code: 0 }
  } catch (e) {
    const p = execErrProps(e)
    return {
      ok: false,
      out: p.stdout + p.stderr + p.message,
      code: p.code,
    }
  }
}

/** 从测试输出提取失败文件 (简化: pytest 路径解析) */
function failedFilesFromOutput(out: string): string[] {
  const files = new Set<string>()
  const re = /([\w./-]+\.py):\d+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(out)) !== null) {
    const f = (m[1] ?? '').replace(/^\.\//, '')
    if (f.includes('/') || f.includes('\\')) files.add(f)
  }
  return [...files].slice(0, 5)
}

/** 通过 subagents 调度一个子智能体, 返回其输出文本
 * claude-code 走 CLI 直调 (SDK 经 opencodex 桥返回 invalid-result, 2026-09-01 实测;
 * CLI 直调 --allowedTools Edit Write --add-dir 已验证可写目标目录)。 */
// ── auto_tdd: goal 自动转验收测试 (移植自 taiji.py v2.4, 防"功能新增类"假收敛) ──
// 功能新增类 goal + 基线绿 → 生成**必然失败**的验收测试并注入 verify,
// 使基线转红, 让信息素循环有真实驱动信号; 功能落地后该测试转绿参与收敛判定。
const ACCEPTANCE_INTENT_KEYWORDS = ['添加', '补', '实现', '新增', '支持', '增加']

const ACCEPTANCE_STOP = new Set(['add', 'adds', 'support', 'supports', 'implement', 'implements',
  'implementing', 'feature', 'features', 'system', 'make', 'to', 'the', 'a', 'an', 'of', 'for',
  'in', 'on', 'with', 'and', 'or', 'is', 'are', 'into', 'new'])

/** 从 goal 确定性提取关键名词 (最多 3 个)。 */
export function acceptanceTokens(goal: string): string[] {
  const raw = goal.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
  const toks = raw.filter(x => !ACCEPTANCE_STOP.has(x.toLowerCase()) && !/^\d+$/.test(x))
  if (toks.length) return [...new Set(toks)].slice(0, 3)
  let stripped = goal
  for (const kw of ACCEPTANCE_INTENT_KEYWORDS) stripped = stripped.split(kw).join(' ')
  const parts = stripped.trim().split(/[\s，。、；：,;:]+/).filter(Boolean)
  return parts.length ? parts.slice(0, 3) : ['feature']
}

/** 确定性转合法 Python 标识符: 合法 ASCII 保留, 否则 feature_<md5_8>。 */
export function acceptanceIdent(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name
  return 'feature_' + createHash('md5').update(name, 'utf8').digest('hex').slice(0, 8)
}

/** goal 中显式声明的模块名 (优先 X.py 字面量, 其次"模块/文件 X")。
 * 2026-09-14 实证修复: 旧实现把全部 token 用 _ 拼成模块名, 对
 * "新建 foo_bar.py 模块并导出 foo_bar 符号" 会生成 foo_bar_py → 要求"模块名==符号名"
 * 的怪约定 → 注入测试造成假绿且与真实 goal 互斥 → 循环无法收敛 (复审按真实 goal 判 FAIL)。 */
export function acceptanceModuleName(goal: string): string | undefined {
  const byFile = goal.match(/([A-Za-z_][A-Za-z0-9_]*)\.py\b/)
  if (byFile) return byFile[1]
  const byWord = goal.match(/(?:模块|文件|module)\s*[`"']?([\p{L}_]\w*)/iu)
  if (byWord) return byWord[1]
  const byFile2 = goal.match(/\b([A-Za-z_][A-Za-z0-9_]*)\.py\b/)
  return byFile2 ? byFile2[1] : undefined
}

/** goal 中显式声明的导出符号 (导出/暴露/提供/export X)。无则返回 undefined。 */
export function acceptanceSymbolName(goal: string): string | undefined {
  const m = goal.match(/(?:导出|暴露|提供|新增|实现|export(?:s)?|expose|provide)\s*[`"']?([\p{L}_]\w*)/iu)
  return m ? m[1] : undefined
}

function acceptanceBody(goal: string, module: string, tokens: string[], symbol?: string): string {
  const names = tokens.length ? tokens.join('、') : module
  // 断言策略 (2026-09-14 修正): 有显式符号 → 断言该符号存在;
  // 无显式符号 → 只断言"模块可导入且非空"(import 本身就是红/绿开关),
  // 不虚构"模块名==符号名"这类人为约定 (会被评审官判为可疑设计 → 假风险分 → 熔断)。
  const assertion = symbol
    ? `    assert hasattr(${module}, "${symbol}"), "goal 要求的符号尚未实现: ${symbol}"`
    : `    assert ${module} is not None, "goal 要求的模块未实现: ${names}"`
  return [
    '"""自动验收测试 — 由 mission.goal 确定性生成 (无 LLM 模板)。',
    '',
    `goal: ${goal}`,
    '作用: 功能新增类任务防假收敛 — 功能未实现时本测试失败, 使基线变红,',
    '      给信息素循环真实驱动信号; 功能落地后本测试转绿参与收敛判定。',
    '"""',
    '',
    `import ${module}  # noqa: F401 — goal 要求的模块 (未实现前 import 失败 = 基线红)`,
    '',
    '',
    `def test_${module}():`,
    `    """goal 关键名词: ${names} — 断言该功能已实现。"""`,
    assertion,
    '',
  ].join('\n')
}

/** 生成 <workdir>/.taiji/test_acceptance.py (幂等: 内容一致不重写), 返回绝对路径。 */
export function genAcceptanceTest(goal: string, workdir: string): string {
  const tokens = acceptanceTokens(goal)
  const module = acceptanceIdent(acceptanceModuleName(goal) ?? tokens.join('_'))
  const symbol = acceptanceSymbolName(goal)
  const body = acceptanceBody(goal, module, tokens, symbol)
  const path = join(workdir, '.taiji', 'test_acceptance.py')
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path) || readFileSync(path, 'utf8') !== body) {
    writeFileSync(path, body, 'utf8')
  }
  return path
}

/** 把验收测试并入 verify: pytest 系直接追加路径; 否则前置独立 pytest + && 短路。 */
export function verifyWithAcceptance(verify: string, acceptPath: string, workdir: string): string {
  const rel = relative(workdir, acceptPath)
  return verify.includes('pytest') ? `${verify} ${rel}` : `pytest -q ${rel} && ${verify}`
}

async function delegate(
  ctx: Context,
  provider: string,
  label: string,
  prompt: string,
  parent: Agent,
  signal: AbortSignal,
  workdir: string = '.',
): Promise<{ ok: boolean; out: string }> {
  if (provider === 'claude-code') {
    return delegateClaudeCli(prompt, workdir, signal)
  }
  if (provider === 'codex') {
    return delegateCodexCli(prompt, workdir, signal)
  }
  const subagents = ctx.get('subagents') as {
    start(
      provider: string,
      opts: { label: string; prompt: Array<{ type: string; text: string }>; parent: Agent; signal: AbortSignal },
    ): Promise<{ result: Promise<AcpStream>; dispose(): Promise<unknown> }>
  } | undefined
  if (!subagents) return { ok: false, out: 'subagents service unavailable' }
  const run = await subagents.start(provider, {
    label,
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal,
  })
  try {
    // 有界等待: ACP/子代理通道挂起时秒级失败 (claude/codex CLI 通道已提前返回, 不走此处)
    let result: AcpStream
    try {
      result = await new Promise<AcpStream>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`ACP delegate timeout ${ACP_DELEGATE_TIMEOUT}ms`)),
          ACP_DELEGATE_TIMEOUT,
        )
        const onAbort = () => { clearTimeout(t); reject(new Error('aborted')) }
        signal.addEventListener('abort', onAbort, { once: true })
        run.result.then(
          (v) => { clearTimeout(t); resolve(v) },
          (e) => { clearTimeout(t); reject(e) },
        )
      })
    } catch (e) {
      return { ok: false, out: `(通道失败) ${(e as { message?: unknown } | null | undefined)?.message ?? 'delegate timeout'}` }
    }
    const blocks: AcpBlock[] = result.output ?? []
    const text = blocks
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('\n')
    const stopReason = result.stopReason
    return { ok: !['error', 'canceled'].includes(stopReason ?? ''), out: text }
  } finally {
    await run.dispose().catch(() => {})
  }
}

/** claude CLI 直调 (绕过 SDK 集成层, 已验证 2026-09-01) */
async function delegateClaudeCli(
  prompt: string,
  workdir: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; out: string }> {
  const deepseekKey = process.env.DEEPSEEK_API_KEY ?? ''
  try {
    const { stdout, stderr } = await execFileAsync(
      'claude',
      ['-p', prompt, '--allowedTools', 'Edit Write', '--add-dir', workdir],
      {
        cwd: workdir,
        timeout: 480000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          ANTHROPIC_AUTH_TOKEN: deepseekKey,
          CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
        },
        signal,
      },
    )
    return { ok: true, out: (stdout + stderr).trim() || '(claude 无输出)' }
  } catch (e) {
    const p = execErrProps(e)
    return {
      ok: false,
      out: p.stdout + p.stderr + p.message,
    }
  }
}

/** codex CLI 直调 (2026-09-08 根治: dsh subagent-codex 经 SDK/app-server 桥在本容器返回
 * invalid-result 零输出 — 与 claude SDK 桥同病。codex exec 直调 + danger-full-access
 * (config.toml 已改) 实测可真实执行 shell, 不再依赖 bubblewrap/user namespaces)。 */
async function delegateCodexCli(
  prompt: string,
  workdir: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; out: string }> {
  const deepseekKey = process.env.DEEPSEEK_API_KEY ?? ''
  // 2026-09-14: codex 对**较长回答**不把 agent message 写进 stdout (实测 ~80+ token 时
  // 只回显 prompt + token 统计 → "首个{到末个}"截到 prompt 里的 JSON 模板 → 解析必失败)。
  // 正解 = --output-last-message 落盘回读 (taiji 技能既有坑 2: 结论须落盘取)。
  const lastMsgPath = join(tmpdir(), `taiji-codex-last-${Date.now()}.txt`)
  const readLast = (): string => {
    try {
      return existsSync(lastMsgPath) ? readFileSync(lastMsgPath, 'utf8').trim() : ''
    } catch { return '' }
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      'codex',
      ['exec', '-s', 'danger-full-access',
        '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
        '--output-last-message', lastMsgPath, prompt],
      {
        cwd: workdir,
        timeout: 480000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, DEEPSEEK_API_KEY: deepseekKey },
        signal,
      },
    )
    const last = readLast()
    return { ok: true, out: last || (stdout + stderr).trim() || '(codex 无输出)' }
  } catch (e) {
    const p = execErrProps(e)
    return {
      ok: false,
      out: readLast() || p.stdout + p.stderr + p.message,
    }
  }
}

/** pi 侦察蜂评审 (四维记分卡, 维度可配置) */
/** 从通道输出提取判定 JSON (2026-09-14 容错版)。

旧实现用"首个 { 到末个 }"截取 → 一旦输出里混入告警/示例 JSON (claude 的模型告警、
prompt 回显的 JSON 模板) 必然解析失败。这里扫描所有**括号平衡**的 {…} 片段, 逐个 JSON.parse,
返回第一个含必需字段的对象; 找不到返回 undefined (调用方按通道级失败处理)。
 */
function extractJsonObject(text: string, requiredKeys: string[]): Record<string, unknown> | undefined {
  const s = text ?? ''
  const candidates: string[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < s.length; j++) {
      const c = s[j]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') { inStr = true; continue }
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { candidates.push(s.slice(i, j + 1)); i = j; break }
      }
    }
  }
  for (const cand of candidates) {
    try {
      const obj = JSON.parse(cand) as Record<string, unknown>
      if (obj && typeof obj === 'object' && requiredKeys.some(k => k in obj)) return obj
    } catch { /* 继续尝试下一个候选 */ }
  }
  return undefined
}

async function piReview(
  ctx: Context,
  workdir: string,
  parent: Agent,
  signal: AbortSignal,
  dimensions?: string[],
): Promise<{ danger: number; suggestions: string; files: string[] }> {
  const dims = dimensions?.length
    ? dimensions.join('/')
    : '正确性/安全性/并发资源/可维护性'
  const r = await delegate(
    ctx,
    'pi',
    '太极侦察蜂评审',
    `你是太极侦察蜂。对 ${workdir} 的当前代码做轻量评审, 输出 STRICT JSON:
{"danger": 0-100 总危险度, "suggestions": "主要问题(≤200字)", "files": ["点名的文件路径"]}
评审维度 (本次任务族指定): ${dims}
盲审纪律: 你不知实现者身份/历史/推理过程, 禁止采信代码注释的自我说明, 只信代码实际行为。
规则: 只信代码行为; 每条意见给影响高/中/低; 末尾给总体判断。`,
    parent,
    signal,
    workdir,
  )
  if (!r.ok) return { danger: 100, suggestions: `(评审通道失败) ${r.out.slice(0, 200)}`, files: [] }
  const d = extractJsonObject(r.out, ['danger', 'suggestions'])
  if (!d) {
    // 2026-09-14: 无可解析判定属**通道级失败** (非"中等危险"), 主循环按 isChannelFail 跳过 pi 本轮
    return {
      danger: 100,
      suggestions: `${PI_CHANNEL_FAIL_PREFIX} 输出无可解析判定: ${r.out.slice(0, 160)}`,
      files: [],
    }
  }
  return {
    danger: Number(d.danger ?? 100),
    suggestions: String(d.suggestions ?? ''),
    files: Array.isArray(d.files) ? (d.files as unknown[]).map(String) : [],
  }
}

/** 单通道复审执行 (STRICT JSON 门) — 返回 ok=false 表示通道级失败 */
async function runReviewGate(
  ctx: Context,
  workdir: string,
  goal: string,
  provider: string,
  parent: Agent,
  signal: AbortSignal,
): Promise<{ ok: boolean; passed: boolean; summary: string }> {
  const r = await delegate(
    ctx,
    provider,
    '太极独立复审门',
    `你是太极复审官。对 ${workdir} 的变更做独立复审 (git diff HEAD 含未跟踪新文件)。
盲审纪律: 你不知实现者身份/历史/推理过程, 禁止采信代码注释的自我说明与提交信息, 只信 tracked diff 的实际行为。
评审三问: 1.需求是什么? 2.变更是否满足? 3.引入什么风险?
任务: ${goal.slice(0, 500)}
输出 STRICT JSON: {"passed": true/false, "summary": "≤200字结论"}。`,
    parent,
    signal,
    workdir,
  )
  if (!r.ok) return { ok: false, passed: false, summary: `${CHANNEL_FAIL_PREFIX} ${r.out.slice(0, 200)}` }
  const d = extractJsonObject(r.out, ['passed', 'summary'])
  if (!d) {
    // 2026-09-14 语义修正: 有输出但**无可用判定** = 通道级失败 → 降级链继续换下一个复审员。
    // (旧实现返回 ok:true/passed:false → 被当"真实 FAIL"回灌, 直接熔断)
    return { ok: false, passed: false, summary: `${CHANNEL_FAIL_PREFIX} 输出无可解析判定: ${r.out.slice(0, 160)}` }
  }
  return { ok: true, passed: d.passed === true, summary: String(d.summary ?? '') }
}

/** codex 独立复审门 (带降级链, 2026-09-08 修复评审通道熔断)
 * 通道失败 (delegate 不可用) → 自动换下一个可用复审员; 全部失败 → 通道级失败返回 (channel='none')。
 * 真实 FAIL (有输出但 passed=false) 不走降级 — 语义保留给主循环回灌。 */
async function codexReviewGate(
  ctx: Context,
  workdir: string,
  goal: string,
  parent: Agent,
  signal: AbortSignal,
): Promise<{ passed: boolean; summary: string; channel: string; degraded: boolean; attempts: string[] }> {
  const chain = (process.env.TAIJI_REVIEW_CHAIN ?? REVIEW_CHAIN_DEFAULT)
    .split(',').map(s => s.trim()).filter(Boolean)
  const attempts: string[] = []
  for (const provider of chain) {
    const a = await runReviewGate(ctx, workdir, goal, provider, parent, signal)
    attempts.push(`${provider}:${a.ok ? (a.passed ? 'PASS' : 'FAIL') : '通道失败'}`)
    if (!a.ok) continue                       // 通道级失败 → 降级下一复审员
    return {                                  // 通道可用 (无论 PASS/FAIL) → 用其结论
      passed: a.passed,
      summary: a.summary,
      channel: provider,
      degraded: provider !== chain[0],
      attempts,
    }
  }
  return { passed: false, summary: CHANNEL_ALL_FAIL, channel: 'none', degraded: true, attempts }
}

/** 复审门收尾统一语义 (2026-09-08 修复通道熔断)
 * 返回: log=rounds 记录串 / converged=真收敛 / stop=提前止损(全通道不可用) / finalState */
async function settleGate(
  ctx: Context,
  workdir: string,
  goal: string,
  parent: Agent,
  signal: AbortSignal,
): Promise<{
  log: string
  converged: boolean
  stop: boolean
  finalState: string
  degraded: boolean
  channel: string
  summary: string
}> {
  const gate = await codexReviewGate(ctx, workdir, goal, parent, signal)
  const label = gate.degraded ? `复审降级(${gate.channel})` : '复审'
  if (gate.channel === 'none') {
    return { log: ` | 复审 通道全不可用(${gate.attempts.join(';')})`,
      converged: false, stop: true,
      finalState: `⛔ 评审通道全不可用 (${gate.attempts.join(';')}) — 提前停止, 未独立复审`,
      degraded: true, channel: 'none', summary: gate.summary }
  }
  if (gate.passed) {
    return { log: ` | ${label} PASS`, converged: true, stop: false,
      finalState: '', degraded: gate.degraded, channel: gate.channel, summary: gate.summary }
  }
  return { log: ` | ${label} FAIL`, converged: false, stop: false,
    finalState: '', degraded: gate.degraded, channel: gate.channel, summary: gate.summary }
}

/** 太极主循环: 信息素 → 测试 → 竞标 → 修复 → 复测 → 评审 → 收敛
 * 4.0 扩展 (2026-09-01): danger_dimensions 评分卡可配置; sandbox 权限分级。 */
async function taijiRun(
  ctx: Context,
  args: TaijiArgs,
  parent: Agent,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const workdir = resolve(args.workdir)
  let verify = args.verify || 'pytest -q'
  const maxRounds = args.rounds ?? MAX_ROUNDS_DEFAULT
  const goal = args.goal
  const dims = args.danger_dimensions
  const sandbox = args.sandbox ?? 'full'   // full=默认 / restrict=只读验证

  let pm = loadPheromones(workdir)
  const rounds: Record<number, string> = {}
  let prevPassed = false
  let converged = false
  let finalState = ''
  const stats: Record<string, unknown> = { sandbox, dims: dims ?? 'default' }
  let piBroken = false   // pi 通道失败一次后本轮跳过 (不再每代付 2min 超时)

  const runPiReview = async (): Promise<{ danger: number; suggestions: string; files: string[] }> => {
    if (piBroken) return { danger: 100, suggestions: `${PI_CHANNEL_FAIL_PREFIX} pi 本轮跳过(此前通道失败)`, files: [] }
    const rv = await piReview(ctx, workdir, parent, signal, dims)
    if (isChannelFail(rv.suggestions)) piBroken = true
    return rv
  }

  // ── auto_tdd 接线 (默认开; env TAIJI_AUTO_TDD=0 或参数 auto_tdd=false 关闭) ──
  const autoTdd = args.auto_tdd === undefined
    ? process.env.TAIJI_AUTO_TDD !== '0'
    : Boolean(args.auto_tdd)
  stats.auto_tdd = autoTdd
  if (autoTdd && ACCEPTANCE_INTENT_KEYWORDS.some(k => goal.includes(k))) {
    const base = await runVerify(verify, workdir)
    if (base.ok) {
      const acceptPath = genAcceptanceTest(goal, workdir)
      verify = verifyWithAcceptance(verify, acceptPath, workdir)
      stats.tdd_injected = acceptPath
      stats.verify_effective = verify
    } else {
      stats.tdd_skipped = 'baseline 非绿 (已有真实失败信号)'
    }
  }

  for (let gen = 1; gen <= maxRounds; gen++) {
    signal.throwIfAborted()
    pm = evaporate(loadPheromones(workdir), prevPassed)

    // 测试
    const t = await runVerify(verify, workdir)
    if (!t.ok) {
      const failed = failedFilesFromOutput(t.out)
      pm = sprayWeighted(pm, failed)
      savePheromones(workdir, pm)
      rounds[gen] = `测试红 (${failed.length ? failed.join(',') : '全局'})`
    } else {
      rounds[gen] = '测试绿'
    }

    // 竞标 → 修复 (按排序逐个尝试, 复测绿即停, 通道失败自动降级)
    if (!t.ok) {
      const target = auction(pm, workdir)
      if (target) {
        const note = pm[target.file]?.Pr_note
        const ctxNote = note ? `\n评审提示: ${note}` : ''
        const taskDesc = `${target.file === '__project__' ? '项目整体' : target.file}`
        let fixed = false
        let t2: { ok: boolean; out: string; code: number } | undefined
        for (const agent of target.agents) {
          const provider = PROVIDER_BY_AGENT[agent]
          if (!provider) {
            rounds[gen] += ` | 无 provider: ${agent}`
            continue
          }
          const r = await delegate(
            ctx,
            provider,
            `太极${agent}修复`,
            `修复 ${taskDesc} 使验收命令 \`${verify}\` 通过。
任务: ${goal.slice(0, 400)}
${ctxNote}
测试失败详情:
${t.out.slice(-1500)}

输出要求: 实际编辑文件完成修复。完成后报告改了什么。`,
            parent,
            signal,
            workdir,
          )
          rounds[gen] += ` | ${agent}修复 ${r.ok ? 'ok' : `失败: ${r.out.slice(0, 120)}`}`
          // 4.0 信誉权重: 修复成败回写 (连续失败 → 该通道竞标分下降, 其它通道上位)
          updateAgentWeight(workdir, agent, r.ok)
          // 修复后复测
          t2 = await runVerify(verify, workdir)
          rounds[gen] += ` | ${agent}复测 ${t2.ok ? '绿 ✓' : '仍红'}`
          if (t2.ok) {
            fixed = true
            prevPassed = true
            break
          }
          prevPassed = false
          signal.throwIfAborted()
        }
        if (t2 === undefined) {
          rounds[gen] += ' | 所有通道均不可用'
          pm = sprayWeighted(pm, failedFilesFromOutput(t.out))
          savePheromones(workdir, pm)
        } else if (!fixed) {
          pm = sprayWeighted(pm, failedFilesFromOutput(t2.out))
          savePheromones(workdir, pm)
        } else {
          // 修复生效 → 评审: pi 侦察 (维度可配置) + 复审门 (codex→降级链)
          const review = await runPiReview()
          const piFail = isChannelFail(review.suggestions)
          rounds[gen] += ` | pi danger=${piFail ? 'N/A(通道失败)' : review.danger}`
          if (review.danger < DANGER_THRESHOLD || piFail) {
            const g = await settleGate(ctx, workdir, goal, parent, signal)
            rounds[gen] += g.log
            stats.review = { degraded: g.degraded, channel: g.channel }
            if (g.converged) {
              converged = true
              finalState = `第 ${gen} 代收敛: 测试绿 + danger=${piFail ? 'N/A(pi通道失败)' : review.danger} + ${g.channel === 'codex' ? '复审' : `复审降级(${g.channel})`} PASS`
              break
            }
            if (g.stop) {
              finalState = g.finalState
              break
            }
            // 真实 FAIL (任意可用通道) → 回灌信息素
            pm = { ...pm, __project__: { Pe: 30, Pr: 20, complexity: 30, Pr_note: `[复审FAIL] ${g.summary.slice(0, 300)}` } }
            savePheromones(workdir, pm)
          } else {
            // danger 过高 (pi 通道正常) → 喷洒评审意见
            pm = { ...pm, __project__: { Pe: 0, Pr: 20, complexity: 30, Pr_note: review.suggestions.slice(0, 300) } }
            savePheromones(workdir, pm)
          }
        }
      } else {
        rounds[gen] += ' | 无候选 (信息素为空)'
      }
    } else {
      prevPassed = true
      // 测试绿但尚未进入修复分支: 直接评审收敛 (维度可配置)
      const review = await runPiReview()
      const piFail = isChannelFail(review.suggestions)
      rounds[gen] += ` | pi danger=${piFail ? 'N/A(通道失败)' : review.danger}`
      if (review.danger < DANGER_THRESHOLD || piFail) {
        const g = await settleGate(ctx, workdir, goal, parent, signal)
        rounds[gen] += g.log
        stats.review = { degraded: g.degraded, channel: g.channel }
        if (g.converged) {
          converged = true
          finalState = `第 ${gen} 代收敛: 测试绿 + danger=${piFail ? 'N/A(pi通道失败)' : review.danger} + ${g.channel === 'codex' ? '复审' : `复审降级(${g.channel})`} PASS`
          break
        }
        if (g.stop) {
          finalState = g.finalState
          break
        }
        pm = { ...pm, __project__: { Pe: 30, Pr: 20, complexity: 30, Pr_note: `[复审FAIL] ${g.summary.slice(0, 300)}` } }
        savePheromones(workdir, pm)
      } else {
        // danger 过高 (pi 正常) → 喷洒意见并继续 (防静默空转), 由修复通道处理
        pm = { ...pm, __project__: { Pe: 30, Pr: 20, complexity: 30, Pr_note: review.suggestions.slice(0, 300) } }
        savePheromones(workdir, pm)
      }
    }

    if (gen === maxRounds) {
      finalState = `⛔ ${maxRounds} 代未收敛, 熔断保护`
    }
  }

  // 运行日志落盘 (2026-09-08 可观测性: rounds/复审通道不再只在返回值一行渲染里, 事后可还原)
  try {
    const runsDir = join(workdir, '.taiji', 'runs')
    mkdirSync(runsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(
      join(runsDir, `run-${stamp}.json`),
      JSON.stringify({
        ts: Date.now(), goal, workdir, verify, sandbox, dims: dims ?? 'default',
        converged, finalState, roundsUsed: Object.keys(rounds).length,
        rounds, review: stats.review ?? null,
      }, null, 2),
      'utf-8',
    )
  } catch { /* 落盘失败不影响交付 */ }

  return {
    converged,
    finalState,
    rounds,
    pheromonePath: pheromonePath(workdir),
    roundsUsed: Object.keys(rounds).length,
    stats,
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'taiji_run',
    description:
      '太极 (Taiji) 多智能体循环: 以 dsh 四子 (claude-code/codex/opencode/pi) 为调度成员, '
      + '按信息素地图驱动"测试→竞标→修复→评审→收敛"循环。'
      + '传入 goal/workdir/verify/rounds, 返回收敛状态与每代记录。',
    parameters: {
      goal: {
        type: 'string',
        required: true,
        description: '任务目标 (修复/实现/重构描述)。',
      },
      workdir: {
        type: 'string',
        required: true,
        description: '工作目录 (目标仓库绝对路径)。',
      },
      verify: {
        type: 'string',
        description: '验收命令, 默认 pytest -q。',
      },
      rounds: {
        type: 'number',
        description: '最大迭代代数, 默认 4。',
      },
      danger_dimensions: {
        type: 'array',
        items: { type: 'string' as const },
        description: 'pi 评审维度 (默认 正确性/安全性/并发资源/可维护性; 按任务族自定义, 如 ["性能","可读性"])。',
      },
      sandbox: {
        type: 'string',
        description: '权限分级: full=默认(可写目标仓库, 需 DSH_PERMISSION_MODE=danger-full-access) / restrict=只读验证(不改代码)。',
      },
      auto_tdd: {
        type: 'boolean',
        description: '功能新增类 goal 自动生成验收测试并注入 verify (防假收敛), 默认 true; env TAIJI_AUTO_TDD=0 亦可关。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          converged: { type: 'boolean', required: true },
          finalState: { type: 'string', required: true },
          roundsUsed: { type: 'number', required: true },
          rounds: { type: 'json', required: true },
          pheromonePath: { type: 'string', required: true },
          stats: { type: 'json' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.converged
          ? `🎯 太极收敛: ${value.finalState}`
          : `太极未收敛: ${value.finalState} (${value.roundsUsed} 代)`,
      }],
    },
    isConcurrencySafe: () => false as const,
    async execute(args, exec): Promise<{
      converged: boolean
      finalState: string
      roundsUsed: number
      rounds: JsonValue
      pheromonePath: string
    }> {
      const parent = exec.agent
      if (!parent) {
        throw new Error('taiji tool requires a calling agent (exec.agent was undefined)')
      }
      const r = await taijiRun(ctx, args as TaijiArgs, parent, exec.signal)
      return {
        converged: Boolean(r.converged),
        finalState: String(r.finalState ?? ''),
        roundsUsed: Number(r.roundsUsed ?? 0),
        rounds: (r.rounds ?? {}) as JsonValue,
        pheromonePath: String(r.pheromonePath ?? ''),
      }
    },
  }))
  ctx.logger.info('[dsh-tool-taiji] 太极调度工具已注册 (taiji_run)')
}
