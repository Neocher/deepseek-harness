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
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, dirname, relative } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'

const execFileAsync = promisify(execFile)

export const name = 'dsh-tool-taiji'

export const inject = ['tools', 'subagents']

/** 竞标专长峰值 (与 taiji.py AGENT_PEAKS 一致)
 * 注意: codex 从修复通道排除 — 本容器 codex app-server 的 bubblewrap 沙箱
 * 需 user namespaces 受限 (2026-09-01 实测), 仅保留 claude_code + opencode 修复。
 * codex 仍以 subagent_codex 独立承担复审门。 */
export const AGENT_PEAKS: Record<string, number> = {
  claude_code: 60,
  opencode: 90,
}

const PROVIDER_BY_AGENT: Record<string, string> = {
  claude_code: 'claude-code',
  opencode: 'opencode',
  codex: 'codex',
}

// ── P1-⑤: 决策参数集中区 (env 覆盖 + 默认值即现值; 来源可考、校准未证) ──
const DANGER_THRESHOLD = Number(process.env.TAIJI_DANGER_THRESHOLD ?? 40)
const MAX_ROUNDS_DEFAULT = Number(process.env.TAIJI_MAX_ROUNDS ?? 4)
const WEIGHT_DECAY = Number(process.env.TAIJI_WEIGHT_DECAY ?? 0.9)
const SPRAY_FILE_PE = Number(process.env.TAIJI_SPRAY_FILE_PE ?? 30)
const SPRAY_GLOBAL_PE = Number(process.env.TAIJI_SPRAY_GLOBAL_PE ?? 20)
const PEVAPOR_GREEN_FACTOR = Number(process.env.TAIJI_PEVAPOR_GREEN ?? 0.5)
const PEVAPOR_GEN_FACTOR = Number(process.env.TAIJI_PEVAPOR_GEN ?? 0.8)
const STIMULUS_PR_FACTOR = Number(process.env.TAIJI_STIMULUS_PR_FACTOR ?? 0.5)

/** 评审通道降级链 (2026-09-08 修复: codex 沙箱在本容器不可用 → 通道失败不再当真实 FAIL)
 * codex → opencode → claude-code (CLI 直调, 已知可用)。env TAIJI_REVIEW_CHAIN 可覆盖。 */
const REVIEW_CHAIN_DEFAULT = 'codex,opencode,claude-code'
const CHANNEL_FAIL_PREFIX = '(复审通道失败)'
const PI_CHANNEL_FAIL_PREFIX = '(评审通道失败)'
const CHANNEL_ALL_FAIL = '(复审通道全不可用)'

/** ACP/子代理委派有界超时 (2026-09-08: pi-acp 桥实测挂起 ~10min 无声失败 —
 * 通道坏时应秒级失败进入降级/门, 不许烧每代 10 分钟)。env TAIJI_DELEGATE_TIMEOUT 可覆盖。 */
const ACP_DELEGATE_TIMEOUT = Number(process.env.TAIJI_DELEGATE_TIMEOUT ?? 120_000)

/** 本次运行生效参数快照 (P1-⑤): 8 决策常量 + 委派超时/复审链/autoTdd + 可选生态。 */
export interface EffectiveParams {
  dangerThreshold: number
  maxRounds: number
  weightDecay: number
  sprayFilePe: number
  sprayGlobalPe: number
  peVaporGreen: number
  peVaporGen: number
  stimulusPrFactor: number
  delegateTimeoutMs: number
  reviewChain: string
  autoTdd: boolean
  parallel: string
  ecosystem?: string
}

/** 生效参数快照 (P1-⑤) — 运行时读 env (不复用加载期常量, 保证可单测)。
 * 无 env 时返回全部现值; ecosystem 可选、不填充 (生态由 stats.ecosystem 记录)。
 * @returns env 覆盖后的生效参数 (8 决策常量 + 委派超时/复审链/autoTdd) */
export function effectiveParams(): EffectiveParams {
  return {
    dangerThreshold: Number(process.env.TAIJI_DANGER_THRESHOLD ?? 40),
    maxRounds: Number(process.env.TAIJI_MAX_ROUNDS ?? 4),
    weightDecay: Number(process.env.TAIJI_WEIGHT_DECAY ?? 0.9),
    sprayFilePe: Number(process.env.TAIJI_SPRAY_FILE_PE ?? 30),
    sprayGlobalPe: Number(process.env.TAIJI_SPRAY_GLOBAL_PE ?? 20),
    peVaporGreen: Number(process.env.TAIJI_PEVAPOR_GREEN ?? 0.5),
    peVaporGen: Number(process.env.TAIJI_PEVAPOR_GEN ?? 0.8),
    stimulusPrFactor: Number(process.env.TAIJI_STIMULUS_PR_FACTOR ?? 0.5),
    delegateTimeoutMs: Number(process.env.TAIJI_DELEGATE_TIMEOUT ?? 120_000),
    reviewChain: process.env.TAIJI_REVIEW_CHAIN ?? REVIEW_CHAIN_DEFAULT,
    autoTdd: process.env.TAIJI_AUTO_TDD !== '0',
    parallel: process.env.TAIJI_PARALLEL === '0' ? '0' : '1',
  }
}

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

/** 落盘告警回调 (生产传 ctx.logger.warn, 测试/无 logger 时 console.warn 兜底)。 */
type WarnFn = (message: string) => void

/** 原子写 JSON: 写 `<path>.tmp-<pid>` → fsync → rename, 避免 writeFileSync 直接覆盖的半写损坏 (C4)。 */
export function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(data, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

export function loadPheromones(workdir: string, warn: WarnFn = console.warn): PheromoneMap {
  const p = pheromonePath(workdir)
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as PheromoneMap
  } catch {
    // 损坏状态不再静默清零: 备份为 .corrupt-<ts> 并告警后重建 (C4)
    try { renameSync(p, `${p}.corrupt-${Date.now()}`) } catch { /* 备份失败不阻断 */ }
    warn(`[taiji] pheromones.json 损坏, 已备份为 ${p}.corrupt-*, 重建为空`)
  }
  return {}
}

export function savePheromones(workdir: string, pm: PheromoneMap): void {
  atomicWriteJson(pheromonePath(workdir), pm)
}

/** 信息素终态分布 (P1-⑤): Pe 的 files/maxPe/minPe/meanPe 四个统计量。 */
export interface PheromoneDistribution {
  files: number
  maxPe: number
  minPe: number
  meanPe: number
}

/** 信息素终态分布统计 (纯函数): 空 map 返回全 0 (无 NaN/Infinity)。
 * @param pm 信息素地图
 * @returns {files, maxPe, minPe, meanPe} */
export function pheromoneDistribution(pm: PheromoneMap): PheromoneDistribution {
  const pe = Object.values(pm)
    .map(n => n.Pe)
    .filter((x): x is number => typeof x === 'number')
  if (pe.length === 0) return { files: 0, maxPe: 0, minPe: 0, meanPe: 0 }
  const sum = pe.reduce((a, b) => a + b, 0)
  return {
    files: pe.length,
    maxPe: Math.max(...pe),
    minPe: Math.min(...pe),
    meanPe: sum / pe.length,
  }
}

/** Pe 蒸发: 测试绿 → ×PEVAPOR_GREEN_FACTOR 强遗忘; 测试红 → 不蒸发 */
function evaporate(pm: PheromoneMap, testsPassed: boolean): PheromoneMap {
  const out: PheromoneMap = {}
  for (const [file, node] of Object.entries(pm)) {
    out[file] = {
      ...node,
      Pe: testsPassed ? Math.round(node.Pe * PEVAPOR_GREEN_FACTOR) : node.Pe,
      // Pr 复合蒸发: 代际 ×PEVAPOR_GEN_FACTOR
      Pr: Math.round(node.Pr * PEVAPOR_GEN_FACTOR),
    }
  }
  return out
}

/** 加权喷洒: 测试失败文件 Pe += SPRAY_FILE_PE, 全局 +SPRAY_GLOBAL_PE */
function sprayWeighted(pm: PheromoneMap, failedFiles: string[]): PheromoneMap {
  const out = { ...pm }
  const global = out['__project__'] ?? { Pe: 0, Pr: 0, complexity: 30 }
  global.Pe += SPRAY_GLOBAL_PE
  out['__project__'] = global
  for (const f of failedFiles) {
    const node = out[f] ?? { Pe: 0, Pr: 0, complexity: 0 }
    node.Pe += SPRAY_FILE_PE
    out[f] = node
  }
  return out
}

/** FNV-1a 32 位哈希 (确定性抖动种子, C6)。 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 竞标微扰 [0,1): 默认确定性 FNV-1a; env TAIJI_RANDOM_BID=1 恢复 Math.random (对照实验, C6)。 */
export function bidJitter(seed: string): number {
  if (process.env.TAIJI_RANDOM_BID === '1') return Math.random()
  return fnv1a(seed) / 0x100000000
}

/** 竞标注入因子 (首次派单, 即排序后 top-1 agent 的注入状态)。 */
export interface AuctionReputation {
  agent: string
  repFactor: number
  streakPenalty: number
}

/** 高斯响应竞标: 每个 agent 有专长刺激区间, 概率微扰后排序 (降序)
 * 4.0 演进: 竞标分 × 信誉权重 (经验引导派单, 修复连续失败者权重下降,
 * 其它通道自动上位 — 修复通道从 claude 独占扩展为权重自动派单)。
 * P1-①: 多目标选择 — excludeFiles 排除已用文件后取 argmax 次优 (单候选自动降级)。
 * P1-③: 竞标分注入全局信誉因子 repFactor × streakPenalty (跨 workdir 派单信誉)。
 * @param pm 信息素地图 (Pe/Pr 双态刺激)
 * @param workdir 工作目录 (读 agent 权重)
 * @param gen 当前代数 (进竞标微扰种子)
 * @param warn 落盘告警回调 (缺省 console.warn)
 * @param excludeFiles 排除的文件集 (多目标换靶时传前 N-1 个 agent 已用文件)
 * @param bucket 经验分桶键 (初始派单传 fingerprint.bucket; 缺省不注入经验)
 * @returns 竞标选中的文件 + 排序后的 agent 列表 + 刺激值 + 首次派单注入因子; 无候选返回 undefined */
export function auction(
  pm: PheromoneMap,
  workdir: string,
  gen: number,
  warn: WarnFn = console.warn,
  excludeFiles?: string[],
  bucket?: string,
): { file: string; agents: string[]; stimulus: number; reputation?: AuctionReputation; experience?: AuctionExperience } | undefined {
  const candidates: string[] = []
  for (const [file, node] of Object.entries(pm)) {
    if ((node.Pe > 0 || node.Pr > 0) && !(excludeFiles ?? []).includes(file)) candidates.push(file)
  }
  if (candidates.length === 0) return undefined
  const file = candidates.reduce((a, b) =>
    (stimulusOf(pm[a] ?? zeroNode) > stimulusOf(pm[b] ?? zeroNode) ? a : b))
  const s = stimulusOf(pm[file] ?? zeroNode)
  const weights = loadAgentWeights(workdir, warn)
  const reps = loadGlobalReputation(warn)
  const expAgents = bucket !== undefined ? loadExperience(warn)[bucket]?.agents : undefined
  const scored: Array<{ agent: string; score: number }> = []
  for (const [agent, peak] of Object.entries(AGENT_PEAKS)) {
    const w = weights[agent] ?? 0
    const jitter = bidJitter(`${workdir}\0${file}\0${agent}\0${gen}`)
    const score = Math.exp(-(((s - peak) / 60) ** 2)) * (0.85 + jitter * 0.3) * (1 + w * 0.2)
      * repFactor(reps[agent]) * streakPenalty(reps[agent]) * expFactor(expAgents?.[agent])
    scored.push({ agent, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  return {
    file,
    agents: scored.map(a => a.agent),
    stimulus: s,
    ...(top ? {
      reputation: {
        agent: top.agent,
        repFactor: repFactor(reps[top.agent]),
        streakPenalty: streakPenalty(reps[top.agent]),
      },
    } : {}),
    ...(top && bucket !== undefined ? {
      experience: {
        bucket,
        expFactor: expFactor(expAgents?.[top.agent]),
      },
    } : {}),
  }
}

/** ── 4.0 演进: agent 信誉权重 (2026-09-01) ────────────────────────────
 * 持久化 .taiji/agent-weights.json: 修复成功 +1 / 失败 -1 (衰减 WEIGHT_DECAY)。
 * 竞标分 × (1 + w*0.2): 连续失败的 agent 信誉下降, 其它通道自动上位。 */
const AGENT_WEIGHTS_FILE = '.taiji/agent-weights.json'

export function loadAgentWeights(workdir: string, warn: WarnFn = console.warn): Record<string, number> {
  const p = resolve(workdir, AGENT_WEIGHTS_FILE)
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, number>
  } catch {
    // 损坏权重文件不再静默清零 (C4): 备份 + 告警
    if (existsSync(p)) {
      try { renameSync(p, `${p}.corrupt-${Date.now()}`) } catch { /* 备份失败不阻断 */ }
      warn('[taiji] agent-weights.json 损坏, 已备份为 .corrupt-*')
    }
    return {}
  }
}

function saveAgentWeights(workdir: string, w: Record<string, number>): void {
  try {
    const p = resolve(workdir, AGENT_WEIGHTS_FILE)
    atomicWriteJson(p, w)
  } catch {
    /* 权重落盘失败不阻断循环 */
  }
}

/** 复测后权重信号: 委派失败→0 (不双计); 复测绿→+1; 复测红或未复测→-1 (C3)。 */
export function agentWeightDelta(rOk: boolean, t2: { ok: boolean } | undefined): number {
  if (!rOk) return 0
  return t2?.ok ? 1 : -1
}

export function updateAgentWeight(workdir: string, agent: string, delta: number, warn: WarnFn = console.warn): void {
  if (delta === 0) return
  const w = loadAgentWeights(workdir, warn)
  for (const k of Object.keys(w)) w[k] = Number(((w[k] ?? 0) * WEIGHT_DECAY).toFixed(3))
  const key = Object.keys(AGENT_PEAKS).find(a => a === agent) ?? agent
  w[key] = Number(((w[key] ?? 0) + delta).toFixed(3))
  saveAgentWeights(workdir, w)
}

/** ── P1-③: 全局 agent 信誉库 (跨 workdir 派单信誉 + 跨进程写保护) ────────────
 * 独立文件 ~/.taiji/global-agent-reputation.json (env TAIJI_GLOBAL_REP 覆盖路径,
 * TAIJI_GLOBAL_REP=0 全局关闭不读不写)。语义分离: workdir 权重=快/本地, 全局信誉=慢/跨仓库。
 * win/loss/streak 状态机: win → wins+1, streak=0; loss → losses+1, streak+1。 */

export interface AgentReputation {
  wins: number
  losses: number
  streak: number
  lastUpdated: number
}

export type ReputationMap = Record<string, AgentReputation>

/** 注入阈值: 样本 (wins+losses) ≥ 5 才把胜率偏差注入竞标打分。 */
const REP_MIN_SAMPLES = 5

/** 乐观并发退避序列 (ms): 初始 1 次 + 3 次重试共 4 次写尝试, 第 4 次仍冲突则告警放弃 (信誉与经验库共用)。 */
const OPTIMISTIC_BACKOFF_MS = [50, 100, 200] as const

/** 全局信誉文件路径: env TAIJI_GLOBAL_REP 非 '0' 时作覆盖路径, 缺省 ~/.taiji/global-agent-reputation.json。 */
export function globalRepPath(): string {
  const env = process.env.TAIJI_GLOBAL_REP
  if (env && env !== '0') return env
  return join(homedir(), '.taiji', 'global-agent-reputation.json')
}

/** TAIJI_GLOBAL_REP=0 → 全局关闭 (不读不写): loadGlobalReputation 返回 {}, recordReputation no-op。 */
export function globalRepDisabled(): boolean {
  return process.env.TAIJI_GLOBAL_REP === '0'
}

/** 持久化文件原始快照 (mtime + 内容, 乐观并发版本比对用)。文件不存在返回 undefined。 */
interface FileSnapshot {
  mtimeMs: number
  content: string
}

function readFileSnapshot(path: string): FileSnapshot | undefined {
  if (!existsSync(path)) return undefined
  return { mtimeMs: statSync(path).mtimeMs, content: readFileSync(path, 'utf-8') }
}

/** 快照版本比对: 两者均 undefined 视为一致; 否则 mtime 与内容均一致才视为未变。 */
function snapshotsEqual(a: FileSnapshot | undefined, b: FileSnapshot | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.mtimeMs === b.mtimeMs && a.content === b.content
}

/** 读全局信誉 (损坏 C4 纪律: 备份 .corrupt-* + 告警 + 空重建); TAIJI_GLOBAL_REP=0 短路返回 {}。 */
export function loadGlobalReputation(warn: WarnFn = console.warn): ReputationMap {
  if (globalRepDisabled()) return {}
  const p = globalRepPath()
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as ReputationMap
  } catch {
    try { renameSync(p, `${p}.corrupt-${Date.now()}`) } catch { /* 备份失败不阻断 */ }
    warn(`[taiji] 全局信誉文件损坏, 已备份为 ${p}.corrupt-*, 重建为空`)
  }
  return {}
}

/** win/loss/streak 状态机 (纯函数): win → wins+1, streak=0; loss → losses+1, streak+1。
 * 3 连败后 win 重置 streak=0 (AC-1); lastUpdated 记录更新时刻 epoch ms。
 * @param rep 既有信誉记录 (缺省视为全零)
 * @param win 本次是否修复成功
 * @param now 更新时刻 epoch ms (缺省 Date.now(); 单测注入固定值保确定性) */
export function applyReputation(rep: AgentReputation | undefined, win: boolean, now: number = Date.now()): AgentReputation {
  const cur = rep ?? { wins: 0, losses: 0, streak: 0, lastUpdated: now }
  return win
    ? { wins: cur.wins + 1, losses: cur.losses, streak: 0, lastUpdated: now }
    : { wins: cur.wins, losses: cur.losses + 1, streak: cur.streak + 1, lastUpdated: now }
}

/** 竞标注入因子 (胜率偏差 ±10%): 样本 ≥ REP_MIN_SAMPLES 才注入, 否则 1.0 (不注入)。 */
export function repFactor(rep: AgentReputation | undefined): number {
  if (!rep) return 1
  const sample = rep.wins + rep.losses
  if (sample < REP_MIN_SAMPLES) return 1
  return 1 + (rep.wins / sample - 0.5) * 0.2
}

/** 连败惩罚: streak ≥ 3 降 15% → 0.85, 否则 1.0。 */
export function streakPenalty(rep: AgentReputation | undefined): number {
  if (!rep) return 1
  return rep.streak >= 3 ? 0.85 : 1
}

/** 同步退避 (Atomics.wait 无 CPU 空转、无新依赖)。 */
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buf, 0, 0, ms)
}

/** 乐观并发读-改-写 + 退避重试 (非锁), 供全局信誉 (recordReputation) 与经验库 (recordExperience) 复用。
 * 每轮: 读快照 before → load() 得当前 map (含损坏 C4 纪律) → update(map) 算 next → 读快照 after;
 * 快照未变则原子写 next 并返回; 变了则退避重试; 初始 1 次 + 3 次重试共 4 次写尝试仍冲突 → warn(conflictMsg) 放弃不抛。
 * @param path 目标持久化文件路径
 * @param load 读 + 损坏 C4 处理回调 (返回当前 map; 损坏时备份 .corrupt-* + 告警 + 返回空 map)
 * @param update 读-改-写回调 (由当前 map 派生 next map, 纯函数)
 * @param warn 落盘告警回调
 * @param conflictMsg 冲突耗尽告警文案 */
function optimisticUpdate<T extends Record<string, unknown>>(
  path: string,
  load: (warn: WarnFn) => T,
  update: (map: T) => T,
  warn: WarnFn,
  conflictMsg: string,
): void {
  for (let attempt = 0; attempt <= OPTIMISTIC_BACKOFF_MS.length; attempt++) {
    const before = readFileSnapshot(path)
    const map = load(warn)
    const next = update(map)
    const after = readFileSnapshot(path)
    if (snapshotsEqual(before, after)) {
      try { atomicWriteJson(path, next) } catch { /* 写失败不阻断主循环 */ }
      return
    }
    if (attempt < OPTIMISTIC_BACKOFF_MS.length) sleepSync(OPTIMISTIC_BACKOFF_MS[attempt] ?? 0)
  }
  warn(conflictMsg)
}

/** 记录一次全局信誉 (乐观并发读-改-写 + 退避重试, 非锁, 经 optimisticUpdate)。
 * TAIJI_GLOBAL_REP=0 时 no-op; 写失败不阻断主循环。 */
export function recordReputation(agent: string, win: boolean, warn: WarnFn = console.warn): void {
  if (globalRepDisabled()) return
  optimisticUpdate(
    globalRepPath(),
    loadGlobalReputation,
    map => ({ ...map, [agent]: applyReputation(map[agent], win) }),
    warn,
    `[taiji] 全局信誉并发冲突, ${OPTIMISTIC_BACKOFF_MS.length} 次重试仍失败, 放弃本次写入 (agent=${agent})`,
  )
}

/** ── P2-②: 抽象经验库 A — 桶级统计经验 (跨 workdir 桶级胜率统计) ────────────
 * 独立文件 ~/.taiji/global-experience.json (env TAIJI_EXP 覆盖路径, TAIJI_EXP=0 全局关闭)。
 * 语义分离: 信誉=agent 全局慢变量; 经验=桶级慢变量 (谁在 category:eco 桶内胜率最高)。
 * 硬约束: 只存 wins/losses 计数 (禁存 LLM 文本/时间戳), 注入只走 auction 打分乘数
 * (expFactor) 不进 prompt — 模型看到的只是派单顺序变化, 无自然语言注入面。 */

/** 单个 agent 在桶内的胜负计数 (只存计数)。 */
export interface AgentExperience {
  wins: number
  losses: number
}

/** 桶级经验: 桶聚合 wins/losses + per-agent 明细 + best/worst 缓存 (load 时由明细重派生)。 */
export interface BucketExperience {
  wins: number
  losses: number
  bestAgent: string
  worstAgent: string
  updated: number
  agents: Record<string, AgentExperience>
}

/** 经验地图: key = bucket (category:eco), value = 桶级经验。 */
export type ExperienceMap = Record<string, BucketExperience>

/** 竞标注入因子 (经验: 首次派单 top-1 agent 的桶内胜率注入状态)。 */
export interface AuctionExperience {
  bucket: string
  expFactor: number
}

/** best/worst 竞争门槛: 样本 (wins+losses) < 3 的 agent 不参与 best/worst 竞争 (小样本不偏置)。 */
const EXP_MIN_SAMPLES = 3

/** 注入门槛: 该 agent 桶内样本 (wins+losses) >= 5 才把胜率偏差注入竞标打分 (±5%, 比全局信誉 ±10% 保守)。 */
const EXP_INJECT_MIN_SAMPLES = 5

/** 经验文件路径: env TAIJI_EXP 非 '0' 时作覆盖路径, 缺省 ~/.taiji/global-experience.json。 */
export function expPath(): string {
  const env = process.env.TAIJI_EXP
  if (env && env !== '0') return env
  return join(homedir(), '.taiji', 'global-experience.json')
}

/** TAIJI_EXP=0 → 全局关闭 (不读不写): loadExperience 返回 {}, recordExperience no-op。 */
export function experienceDisabled(): boolean {
  return process.env.TAIJI_EXP === '0'
}

/** 由 per-agent 明细派生 best/worst: 样本 < EXP_MIN_SAMPLES 不参与竞争;
 * 平局 best 取插入序靠前 (先达标), worst 取插入序靠后 (后达标)。无竞争者均返回 ''。 */
function deriveBestWorst(agents: Record<string, AgentExperience>): { bestAgent: string; worstAgent: string } {
  let bestAgent = ''
  let worstAgent = ''
  let bestRate = -1
  let worstRate = 2
  for (const [agent, rec] of Object.entries(agents)) {
    const sample = rec.wins + rec.losses
    if (sample < EXP_MIN_SAMPLES) continue
    const rate = rec.wins / sample
    if (rate > bestRate) { bestRate = rate; bestAgent = agent }
    if (rate <= worstRate) { worstRate = rate; worstAgent = agent }
  }
  return { bestAgent, worstAgent }
}

/** 读经验库 (损坏 C4 纪律: 备份 .corrupt-* + 告警 + 空重建); TAIJI_EXP=0 短路返回 {}。
 * 逐桶用 agents 明细重派生 bestAgent/worstAgent, 缓存与明细不符以派生为准 (防半写)。 */
export function loadExperience(warn: WarnFn = console.warn): ExperienceMap {
  if (experienceDisabled()) return {}
  const p = expPath()
  try {
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as ExperienceMap
      const out: ExperienceMap = {}
      for (const [bucket, rec] of Object.entries(raw)) {
        const { bestAgent, worstAgent } = deriveBestWorst(rec.agents)
        out[bucket] = {
          wins: rec.wins,
          losses: rec.losses,
          bestAgent,
          worstAgent,
          updated: rec.updated,
          agents: rec.agents,
        }
      }
      return out
    }
  } catch {
    try { renameSync(p, `${p}.corrupt-${Date.now()}`) } catch { /* 备份失败不阻断 */ }
    warn(`[taiji] 经验文件损坏, 已备份为 ${p}.corrupt-*, 重建为空`)
  }
  return {}
}

/** 桶级经验更新 (纯函数): 按 agent 累加 wins/losses, 同步桶聚合, 现场派生 best/worst。
 * @param bucket 既有桶经验 (缺省视为空桶)
 * @param agent 本次 agent
 * @param ok 本次是否成功 (win)
 * @param now 更新时刻 epoch ms (缺省 Date.now(); 单测注入固定值保确定性)
 * @returns 更新后的桶经验 */
export function applyExperience(
  bucket: BucketExperience | undefined,
  agent: string,
  ok: boolean,
  now: number = Date.now(),
): BucketExperience {
  const cur = bucket ?? { wins: 0, losses: 0, bestAgent: '', worstAgent: '', updated: now, agents: {} }
  const agents = { ...cur.agents }
  const prev = agents[agent] ?? { wins: 0, losses: 0 }
  agents[agent] = ok
    ? { wins: prev.wins + 1, losses: prev.losses }
    : { wins: prev.wins, losses: prev.losses + 1 }
  const { bestAgent, worstAgent } = deriveBestWorst(agents)
  return {
    wins: cur.wins + (ok ? 1 : 0),
    losses: cur.losses + (ok ? 0 : 1),
    bestAgent,
    worstAgent,
    updated: now,
    agents,
  }
}

/** 竞标注入因子 (桶内胜率偏差 ±5%): 样本 >= EXP_INJECT_MIN_SAMPLES 才注入, 否则 1.0 (不注入)。 */
export function expFactor(exp: AgentExperience | undefined): number {
  if (!exp) return 1
  const sample = exp.wins + exp.losses
  if (sample < EXP_INJECT_MIN_SAMPLES) return 1
  return 1 + (exp.wins / sample - 0.5) * 0.1
}

/** 记录一次桶级经验 (乐观并发读-改-写 + 退避重试, 非锁, 与 recordReputation 同款)。
 * TAIJI_EXP=0 时 no-op; 写失败不阻断主循环。 */
export function recordExperience(bucket: string, agent: string, ok: boolean, warn: WarnFn = console.warn): void {
  if (experienceDisabled()) return
  optimisticUpdate(
    expPath(),
    loadExperience,
    map => ({ ...map, [bucket]: applyExperience(map[bucket], agent, ok) }),
    warn,
    `[taiji] 经验并发冲突, ${OPTIMISTIC_BACKOFF_MS.length} 次重试仍失败, 放弃本次写入 (bucket=${bucket}, agent=${agent})`,
  )
}

function stimulusOf(node: PheromoneNode): number {
  return node.Pe + node.Pr * STIMULUS_PR_FACTOR
}

/** verify 中禁用的 shell 元字符 (按序检测, 多字符序列在前)。 */
const VERIFY_SHELL_METACHARS = ['&&', '||', '$(', '`', ';', '|', '>', '<', '&'] as const

/** 命中第一个未允许的 shell 元字符, 无则返回 undefined。 */
function verifyShellMetachar(verify: string): string | undefined {
  for (const c of VERIFY_SHELL_METACHARS) {
    if (verify.includes(c)) return c
  }
  return undefined
}

/** 运行 verify 命令 (C2): 默认免 shell (空白分词 execFile, cwd=resolve(workdir));
 * 含未允许元字符 → 拒绝; env TAIJI_VERIFY_SHELL_OK=1 恢复 bash -c 旧行为。 */
export async function runVerify(
  verify: string,
  workdir: string,
  timeoutMs = 300000,
): Promise<{ ok: boolean; out: string; code: number; skipped?: boolean }> {
  if (process.env.TAIJI_VERIFY_SHELL_OK === '1') {
    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-c', verify], {
        cwd: resolve(workdir),
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      })
      return { ok: true, out: stdout + stderr, code: 0 }
    } catch (e) {
      const p = execErrProps(e)
      return { ok: false, out: p.stdout + p.stderr + p.message, code: p.code }
    }
  }
  const meta = verifyShellMetachar(verify)
  if (meta !== undefined) {
    return { ok: false, out: `verify 含未允许 shell 元字符: ${meta}`, code: 1, skipped: true }
  }
  const tokens = verify.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return { ok: false, out: 'verify 为空', code: 1, skipped: true }
  }
  const cmd = tokens[0] ?? ''
  const restArgs = tokens.slice(1)
  try {
    const { stdout, stderr } = await execFileAsync(cmd, restArgs, {
      cwd: resolve(workdir),
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, out: stdout + stderr, code: 0 }
  } catch (e) {
    const p = execErrProps(e)
    return { ok: false, out: p.stdout + p.stderr + p.message, code: p.code }
  }
}

/** 从测试输出提取失败文件 (C8): .py / FAIL <path> / error TS#### / <path>:line:col / Go <path>:line:col:;
 * env TAIJI_FAILED_FILE_RE 覆盖为自定义正则 (取 m[1] ?? m[0])。 */
export function failedFilesFromOutput(out: string): string[] {
  const files = new Set<string>()
  const custom = process.env.TAIJI_FAILED_FILE_RE
  const patterns: RegExp[] = custom
    ? [new RegExp(custom, 'g')]
    : [
      /([\w./-]+\.py):\d+/g,
      /\bFAIL\s+([^\s:]+)/g,
      /\berror\s+TS\d+:\s*([^\s:]+)/g,
      /([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|go)):\d+:\d+:?/g,
    ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(out)) !== null) {
      const f = (m[1] ?? m[0] ?? '').replace(/^\.\//, '')
      if (f && (f.includes('/') || f.includes('\\'))) files.add(f)
    }
  }
  return [...files].slice(0, 5)
}

/** 获取 workdir 下 `git status --porcelain` 的变更文件 (modified + untracked),
 * 去前 3 字符状态前缀后返回文件路径; 非 git 仓库或执行异常返回 []。 */
export async function getChangedFiles(workdir: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: resolve(workdir), timeout: 10_000, maxBuffer: 1024 * 1024,
    })
    return stdout.split('\n').map(l => l.slice(3).trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** ── P2-③: 隔离并行 B — 真 worktree 隔离 + 择优 ────────────────────────────
 * 用 git worktree 为前 2 个 agent 各自隔离工作树并行 delegate+verify,
 * 择优回写胜者文件到主 workdir 并复测; 失败 (建 wt 失败/双红/wt绿主红/未触发) 一律降级串行。 */

/** 并行未触发/降级原因 (stats.parallel.fallback 取值)。 */
export type ParallelFallback = 'non-git' | 'untracked' | 'disabled' | 'single-agent' | 'project-level'

/** 单个 agent 的并行竞标结果 (ok = wt 内 delegate.ok && verify.ok; settledMs = 完成耗时)。 */
export interface ParallelAgentResult {
  agent: string
  ok: boolean
  settledMs: number
}

/** 并行观测快照: used=是否并行, winner=胜出 agent, losers=落败 agents, fallback=未并行原因。 */
export interface ParallelStats {
  used: boolean
  winner?: string
  losers?: string[]
  fallback?: ParallelFallback
}

/** 为 agent 建隔离 worktree (git worktree add <tmpRoot>/taiji-<id> -b <branch> HEAD)。
 * tmpRoot = /tmp/taiji-wt-<pid> (mkdir -p); 非 git 仓库或命令失败 → ok=false 不抛。
 * @param workdir 主工作目录 (git 仓库根)
 * @param id worktree 目录名后缀 (taiji-<id>)
 * @param branch 新建分支名 (taiji/<gen>-<agent>-<ts>)
 * @returns {ok, path, out} — ok=false 时调用方降级串行 */
export async function worktreeFor(
  workdir: string,
  id: string,
  branch: string,
): Promise<{ ok: boolean; path: string; out: string }> {
  const tmpRoot = join(tmpdir(), `taiji-wt-${process.pid}`)
  const path = join(tmpRoot, `taiji-${id}`)
  try {
    mkdirSync(tmpRoot, { recursive: true })
    const { stdout, stderr } = await execFileAsync('git', ['worktree', 'add', path, '-b', branch, 'HEAD'], {
      cwd: resolve(workdir),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    return { ok: true, path, out: stdout + stderr }
  } catch (e) {
    const p = execErrProps(e)
    return { ok: false, path, out: p.stdout + p.stderr + p.message }
  }
}

/** 清理 worktree + 分支 (fire-and-forget, 失败 console.warn 不抛; finally 必调防堆积)。
 * @param workdir 主工作目录 (git 仓库根)
 * @param path worktree 绝对路径
 * @param branch worktree 对应分支名 */
export function worktreeRemove(workdir: string, path: string, branch: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', path], {
      cwd: resolve(workdir), timeout: 30_000, stdio: 'ignore',
    })
  } catch (e) {
    console.warn(`[taiji] worktree remove 失败: ${String(e)}`)
  }
  try {
    execFileSync('git', ['branch', '-D', branch], {
      cwd: resolve(workdir), timeout: 30_000, stdio: 'ignore',
    })
  } catch (e) {
    console.warn(`[taiji] branch 删除失败: ${String(e)}`)
  }
}

/** 择优回写: 读 wt 工作树文件写入主 workdir (不切分支)。
 * agent 在 wt 内不 commit (delegate 只发 Edit/Write), 故不能用 `git show HEAD:<file>`
 * (只会返回修复前旧内容); 读 wt 工作树文件等价实现"回写修复后的文件"。文件不存在 → ok=false。
 * @param workdir 主工作目录
 * @param wtPath worktree 绝对路径
 * @param file 相对路径的目标文件
 * @returns {ok, out} */
export async function checkoutFromWorktree(
  workdir: string,
  wtPath: string,
  file: string,
): Promise<{ ok: boolean; out: string }> {
  const src = join(wtPath, file)
  if (!existsSync(src)) return { ok: false, out: `worktree 中无此文件: ${file}` }
  try {
    const content = await readFile(src, 'utf-8')
    const dst = join(workdir, file)
    mkdirSync(dirname(dst), { recursive: true })
    await writeFile(dst, content, 'utf-8')
    return { ok: true, out: '' }
  } catch (e) {
    return { ok: false, out: String(e) }
  }
}

/** 并行择优 (纯函数): 恰一个绿 → 该 agent 胜出; 双绿 → settledMs 最小者胜出; 双红 → null。
 * @param results 各 agent 的 {agent, ok, settledMs}
 * @returns 胜出者或 null (无人胜出) */
export function pickWinner(results: ParallelAgentResult[]): ParallelAgentResult | null {
  const greens = results.filter(r => r.ok)
  if (greens.length === 0) return null
  if (greens.length === 1) return greens[0] ?? null
  return greens.reduce((a, b) => (a.settledMs <= b.settledMs ? a : b))
}

/** 并行降级原因判定 (纯函数): disabled → single-agent → project-level → non-git → untracked → undefined。
 * 全满足返回 undefined (走并行)。
 * @param parallelEnabled TAIJI_PARALLEL 是否非 '0'
 * @param agentCount 竞标 agent 数
 * @param file 竞标选中的目标文件
 * @param gitTrack git 追踪状态
 * @returns 降级原因或 undefined (可并行) */
export function parallelFallbackReason(
  parallelEnabled: boolean,
  agentCount: number,
  file: string,
  gitTrack: 'tracked' | 'non-git' | 'untracked',
): ParallelFallback | undefined {
  if (!parallelEnabled) return 'disabled'
  if (agentCount < 2) return 'single-agent'
  if (file === '__project__') return 'project-level'
  if (gitTrack === 'non-git') return 'non-git'
  if (gitTrack === 'untracked') return 'untracked'
  return undefined
}

/** git 追踪状态一次判 (内部, 不导出): `git ls-files --error-unmatch -- <file>`。
 * stderr 含 'not a git repository' → non-git; 其余非零退出 (pathspec 未匹配) → untracked。 */
async function gitTrackStatus(workdir: string, file: string): Promise<'tracked' | 'non-git' | 'untracked'> {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', file], {
      cwd: resolve(workdir),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    return 'tracked'
  } catch (e) {
    const p = execErrProps(e)
    return p.stderr.includes('not a git repository') ? 'non-git' : 'untracked'
  }
}

/** 并行委派 + verify (前 2 agent 各在 wt 内并行), 按固定下标返回 {agent, ok, settledMs}。
 * delegate/runVerify 为注入回调 (生产绑定 ctx/parent/signal/sandbox/prompt/verify; 单测传 mock 断言 workdir)。
 * @param params agents (含 path)/注入 delegate + runVerify
 * @returns 按下标对齐的并行结果 (ok = delegate.ok && verify.ok; settledMs 取公共起点到完成耗时) */
export async function parallelAttempt(params: {
  agents: Array<{ agent: string; provider: string; path: string }>
  delegate: (provider: string, label: string, workdir: string) => Promise<{ ok: boolean; out: string }>
  runVerify: (workdir: string) => Promise<{ ok: boolean; out: string; code: number }>
}): Promise<ParallelAgentResult[]> {
  const results: ParallelAgentResult[] = params.agents.map(a => ({ agent: a.agent, ok: false, settledMs: 0 }))
  const start = Date.now()
  await Promise.allSettled(
    params.agents.map((a, i) => (async () => {
      const r = await params.delegate(a.provider, `太极${a.agent}修复`, a.path)
      const v = await params.runVerify(a.path)
      results[i] = { agent: a.agent, ok: r.ok && v.ok, settledMs: Date.now() - start }
    })()),
  )
  return results
}

/** 并行胜出的修复信号记录 (零变更门→权重→信誉→经验), 与串行同口径。
 * 胜出 agent 记 win (weightDelta 走零变更门), 落败 agents 记 loss (weightDelta=0 仅信誉/经验)。
 * 三个落盘函数为注入回调: 生产传真实实现, 单测传 mock 计数 (spec 判据 6)。
 * @param params winner/losers/bucket/workdir/changedFiles/failedFiles/rOk/t2Ok/warn + 注入的落盘回调
 * @returns {weightDelta, hasChange} 供调用方记录零变更门/机械门日志 */
export function recordParallelSignals(params: {
  winner: string
  losers: string[]
  bucket: string
  workdir: string
  changedFiles: string[]
  failedFiles: string[]
  rOk: boolean
  t2Ok: boolean
  warn: WarnFn
  updateAgentWeight: (workdir: string, agent: string, delta: number, warn: WarnFn) => void
  recordReputation: (agent: string, win: boolean, warn: WarnFn) => void
  recordExperience: (bucket: string, agent: string, ok: boolean, warn: WarnFn) => void
}): { weightDelta: number; hasChange: boolean } {
  const { winner, losers, bucket, workdir, changedFiles, failedFiles, rOk, t2Ok, warn } = params
  const hasChange = hasRelevantChange(changedFiles, failedFiles)
  const weightDelta = hasChange ? agentWeightDelta(rOk, { ok: t2Ok }) : 0
  params.updateAgentWeight(workdir, winner, weightDelta, warn)
  params.recordReputation(winner, t2Ok && weightDelta > 0, warn)
  params.recordExperience(bucket, winner, t2Ok && weightDelta > 0, warn)
  for (const loser of losers) {
    params.recordReputation(loser, false, warn)
    params.recordExperience(bucket, loser, false, warn)
  }
  return { weightDelta, hasChange }
}

/** 双向 substring 相交判定: a 中任一路径与 b 中任一路径互相包含即命中
 * (零变更门与 gate-scope 门共用, 避免两份相交逻辑漂移)。 */
export function filesIntersect(a: string[], b: string[]): boolean {
  return a.some(af => b.some(bf => af.includes(bf) || bf.includes(af)))
}

/** 零变更门相交判定: 变更文件集与失败文件集是否存在任一双向 substring 命中。
 * 空 changed → false (无变更不计权重); 空 failed → 降级为只看 changed 非空。 */
export function hasRelevantChange(changedFiles: string[], failedFiles: string[]): boolean {
  if (changedFiles.length === 0) return false
  if (failedFiles.length === 0) return true
  return filesIntersect(changedFiles, failedFiles)
}

/** 单门判定结果: 门名 + 独立布尔 + detail (供 D 证据链落盘)。 */
export interface GateResult { name: string; ok: boolean; detail: string }

/** mechanicalGates 入参: 复用 getChangedFiles/failedFilesFromOutput 产物;
 * tsconfigAvailable 由调用方探测后传入 (函数自身不碰 existsSync, 保持纯函数)。 */
export interface MechanicalGateInput {
  workdir: string
  diffFiles: string[]
  failedFiles: string[]
  verify: string
  tsconfigAvailable?: boolean
}

/** 禁止模式门规则 (P2 外置 .taiji/gates.json 留口): re 存无 /g 源,
 * 扫描时 new RegExp(source, 'g') 重建, 规避跨文件共享 lastIndex。 */
interface ForbiddenRule {
  id: string
  re: RegExp
  langs: string[] | null
  warn: boolean
}

const GATE_RULES: { forbiddenPatterns: ForbiddenRule[] } = {
  forbiddenPatterns: [
    { id: 'bare-except', re: /\bexcept\s*:/, langs: ['.py'], warn: false },
    { id: 'empty-catch', re: /\bcatch\s*\(\s*\w+\s*\)\s*\{\s*\}/, langs: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], warn: false },
    { id: 'console-log', re: /\bconsole\.log\s*\(/, langs: null, warn: true },
  ],
}

/** 计算 text 中 index 之前 (含) 的换行数 + 1 = 1-based 行号。 */
function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

/** gate-typecheck: TS 生态 (tsconfigAvailable) 且有 .ts/.tsx 变更 → 工具链可用性探测
 * (非全量 typecheck, spec 明示 monorepo 全量 tsc 太贵)。env TAIJI_TSC_BIN 覆盖二进制名
 * (默认 npx/args ['tsc','--version']; 覆盖时 args ['--version']), 60s 超时 fail-closed。 */
async function gateTypecheck(diffFiles: string[], tsconfigAvailable?: boolean): Promise<GateResult> {
  const hasTsChange = diffFiles.some(f => /\.tsx?$/.test(f))
  if (!tsconfigAvailable || !hasTsChange) {
    return { name: 'gate-typecheck', ok: true, detail: '非 TS 生态, 跳过' }
  }
  const bin = process.env.TAIJI_TSC_BIN ?? 'npx'
  const args = process.env.TAIJI_TSC_BIN ? ['--version'] : ['tsc', '--version']
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 60_000, maxBuffer: 1024 * 1024 })
    const ver = (stdout || '').trim()
    return { name: 'gate-typecheck', ok: true, detail: ver ? `tsc 可用: ${ver}` : 'tsc 可用' }
  } catch (e) {
    const err = e as { killed?: boolean; signal?: string }
    const timedOut = err.killed === true || err.signal === 'SIGTERM'
    const p = execErrProps(e)
    const detail = timedOut
      ? 'tsc 不可用: timeout'
      : `tsc 不可用: ${p.message || p.stderr || '探测失败'}`
    return { name: 'gate-typecheck', ok: false, detail }
  }
}

/** gate-forbidden-patterns: 对 diffFiles 逐个读文件 (只读新增/修改, 非全仓库) 扫禁止模式,
 * 命中列 文件:行号。硬命中 (bare-except/empty-catch) 优先: detail 不含 warn-level 字面;
 * 仅 console.log (warn) 命中时才标 warn-level, 供调用方决定硬 fail 还是记录。 */
async function gateForbiddenPatterns(workdir: string, diffFiles: string[]): Promise<GateResult> {
  const hardHits: string[] = []
  const warnHits: string[] = []
  for (const f of diffFiles) {
    let content: string
    try {
      content = readFileSync(join(workdir, f), 'utf-8')
    } catch {
      continue // 已删除/不存在的 diffFile 跳过, 不阻断整门 (A5)
    }
    for (const rule of GATE_RULES.forbiddenPatterns) {
      if (rule.langs !== null && !rule.langs.some(ext => f.endsWith(ext))) continue
      const re = new RegExp(rule.re.source, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(content)) !== null) {
        const entry = `${f}:${lineNumberAt(content, m.index)}`
        if (rule.warn) warnHits.push(entry)
        else hardHits.push(entry)
      }
    }
  }
  if (hardHits.length > 0) {
    const detail = [`禁止模式: ${hardHits.join(', ')}`]
    if (warnHits.length > 0) detail.push(`告警: ${warnHits.join(', ')}`)
    return { name: 'gate-forbidden-patterns', ok: false, detail: detail.join('; ') }
  }
  if (warnHits.length > 0) {
    return { name: 'gate-forbidden-patterns', ok: false, detail: `warn-level: console.log 残留 ${warnHits.join(', ')}` }
  }
  return { name: 'gate-forbidden-patterns', ok: true, detail: '无禁止模式命中' }
}

/** 异源机械判官层 (export 纯函数): 四门全跑完再汇总, 任一硬 fail 不阻断其他门判定。
 * 返回固定顺序 [gate-zero-change, gate-scope, gate-typecheck, gate-forbidden-patterns]。 */
export async function mechanicalGates(input: MechanicalGateInput): Promise<GateResult[]> {
  const { workdir, diffFiles, failedFiles, tsconfigAvailable } = input

  const zeroChange: GateResult = diffFiles.length > 0
    ? { name: 'gate-zero-change', ok: true, detail: `变更文件 ${diffFiles.length} 个` }
    : { name: 'gate-zero-change', ok: false, detail: `零变更 (diffFiles 共 ${diffFiles.length} 个文件)` }

  let scope: GateResult
  if (failedFiles.length === 0) {
    scope = { name: 'gate-scope', ok: true, detail: '无失败文件可对比, 跳过' }
  } else {
    const hit = filesIntersect(diffFiles, failedFiles)
    scope = hit
      ? { name: 'gate-scope', ok: true, detail: `变更与失败文件相交 (${diffFiles.length} 变更 vs ${failedFiles.length} 失败)` }
      : { name: 'gate-scope', ok: false, detail: `变更文件与失败文件无交集 (${diffFiles.length} 变更 vs ${failedFiles.length} 失败)` }
  }

  const [typecheck, forbidden] = await Promise.all([
    gateTypecheck(diffFiles, tsconfigAvailable),
    gateForbiddenPatterns(workdir, diffFiles),
  ])

  return [zeroChange, scope, typecheck, forbidden]
}

/** 读端评审意见解析 (P1-②): 优先本文件 Pr_note; 无则回退 __project__ 全局评审意见。
 * @param pm 信息素地图
 * @param file 竞标选中的目标文件
 * @returns 文件自身 note 命中即返回; file 为 __project__ 时返回其自身 note (undefined 即无);
 * 否则回退 __project__ 的 Pr_note, 均无返回 undefined */
export function resolvePrNote(pm: PheromoneMap, file: string): string | undefined {
  const fileNote = pm[file]?.Pr_note
  if (fileNote) return fileNote
  if (file === '__project__') return undefined
  return pm['__project__']?.Pr_note
}

/** 项目级评审意见写入 (P1-②): 保留 __project__ 既有 Pe/Pr (不擦除 sprayWeighted 累计),
 * 仅 fresh (Pe===0 && Pr===0) 时应用 base 基础刺激, 始终覆盖 Pr_note。
 * @param pm 信息素地图
 * @param note 评审意见文本
 * @param base 首次写入的基础刺激 (Pe/Pr), 缺省时不改变零值
 * @returns 更新 __project__ 节点后的新信息素地图 */
export function setProjectNote(pm: PheromoneMap, note: string, base?: { Pe: number; Pr: number }): PheromoneMap {
  const prev = pm['__project__'] ?? { Pe: 0, Pr: 0, complexity: 30 }
  const fresh = prev.Pe === 0 && prev.Pr === 0
  const merged = fresh && base ? { ...prev, ...base } : { ...prev }
  return { ...pm, __project__: { ...merged, complexity: merged.complexity ?? 30, Pr_note: note } }
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

/** 工作目录生态 (P1-⑦): 只认 lockfile/配置文件存在性, 不读 package.json scripts 字段。
 * 'ts' 保留供类型前瞻 (probeEcosystem 永不产出 'ts', 只产出 node/python/none)。 */
export type Ecosystem = 'python' | 'ts' | 'node' | 'none'

/** 生态探测结果: eco 生态类别 + node 系 pkgManager + 缺省 verify 命令。 */
export interface EcosystemInfo {
  eco: Ecosystem
  pkgManager?: 'pnpm' | 'yarn' | 'npm'
  defaultVerify: string
}

/** 探测工作目录生态 (确定性, 只认 lockfile/配置文件存在性):
 * pnpm-lock.yaml → pnpm / yarn.lock → yarn / package-lock.json → npm (优先级 pnpm > yarn > npm);
 * requirements.txt / pyproject.toml / setup.py → python; 均无 → none。
 * @param workdir 工作目录 (绝对路径)
 * @returns 生态信息 (eco + pkgManager? + defaultVerify) */
export function probeEcosystem(workdir: string): EcosystemInfo {
  if (existsSync(join(workdir, 'pnpm-lock.yaml'))) {
    return { eco: 'node', pkgManager: 'pnpm', defaultVerify: 'pnpm test' }
  }
  if (existsSync(join(workdir, 'yarn.lock'))) {
    return { eco: 'node', pkgManager: 'yarn', defaultVerify: 'yarn test' }
  }
  if (existsSync(join(workdir, 'package-lock.json'))) {
    return { eco: 'node', pkgManager: 'npm', defaultVerify: 'npm test' }
  }
  if (existsSync(join(workdir, 'requirements.txt'))
    || existsSync(join(workdir, 'pyproject.toml'))
    || existsSync(join(workdir, 'setup.py'))) {
    return { eco: 'python', defaultVerify: 'pytest -q' }
  }
  return { eco: 'none', defaultVerify: 'echo "no ecosystem"' }
}

/** P2-①: 任务指纹 (task fingerprint — 抽象经验库分桶前置, 纯确定性) ────────────
 * category 用三张独立关键词表 (fix > feature > refactor, 先命中先停, 全不中 unknown),
 * 与 auto_tdd 的 ACCEPTANCE_INTENT_KEYWORDS 独立不合并 (两用途各自演进);
 * eco 复用 probeEcosystem(workdir).eco; fp 尾部 = normalizeGoal(goal)。 */
const CATEGORY_FIX = ['修复', '修', 'fix', 'bug', '错误', '报错', '失败', '回归', 'regression', 'error']
const CATEGORY_FEATURE = ['添加', '新增', '实现', '支持', '增加', '补', 'add', 'implement', 'support', 'new', 'feature']
const CATEGORY_REFACTOR = ['重构', 'refactor', '优化', 'performance', '性能', '清理', 'cleanup', '提取', 'extract']

/** 任务指纹 (P2-①): category 互斥类别 + eco 生态透传 + bucket 分桶键 + fp 完整指纹。 */
export interface TaskFingerprint {
  category: 'fix' | 'feature' | 'refactor' | 'unknown'
  eco: string
  bucket: string
  fp: string
}

/** category 判定 (确定性, 互斥, 先命中先停): fix > feature > refactor, 全不中 → unknown。
 * 只 goal.toLowerCase() 后 includes, 中文不 lower 无影响 (粗分类允许 unknown 合法存在)。 */
function categoryOf(goal: string): TaskFingerprint['category'] {
  const g = goal.toLowerCase()
  if (CATEGORY_FIX.some(k => g.includes(k))) return 'fix'
  if (CATEGORY_FEATURE.some(k => g.includes(k))) return 'feature'
  if (CATEGORY_REFACTOR.some(k => g.includes(k))) return 'refactor'
  return 'unknown'
}

/** 全角转半角 (U+FF01–U+FF5E 映射块 + 全角空格 U+3000): 标准全角→半角映射,
 * 含全角字母数字与标点, 归一更彻底 (不影响 category — category 走原始 lowercased goal)。 */
function toHalfWidth(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x3000) out += ' '
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0)
    else out += ch
  }
  return out
}

/** goal 归一化 (fp 字段用): trim → 全角转半角 → 连续空白压缩为单空格 → 截 80 → 转小写。 */
function normalizeGoal(goal: string): string {
  return toHalfWidth(goal.trim()).replace(/\s+/g, ' ').slice(0, 80).toLowerCase()
}

/** 任务指纹 (P2-①): 纯确定性分桶键, 供经验库"按可复现指纹分桶、跨类别不硬套"。
 * 禁 LLM/禁随机; 同 (goal, workdir) 两次调用结果完全一致 (重放判据)。
 * @param goal 任务目标 (category 判定不归一化, 空串 → unknown + fp 尾空串)
 * @param workdir 工作目录 (绝对路径, workdir 不存在时 probeEcosystem 自身返回 none)
 * @returns 指纹 {category, eco, bucket, fp} */
export function taskFingerprint(goal: string, workdir: string): TaskFingerprint {
  const category = categoryOf(goal)
  const eco = probeEcosystem(workdir).eco
  const bucket = `${category}:${eco}`
  const fp = `${bucket}:${normalizeGoal(goal)}`
  return { category, eco, bucket, fp }
}

/** TS 生态验收测试模板 (确定性): 只断言目标模块文件存在 (existsSync), 不虚构 import
 * 路径/符号约定 (与 Python 路径"不虚构人为约定"纪律一致; symbol 断言留待 P2 读 tsconfig paths)。
 * 签名有意只收 goal/module 两参: spec 草案的 tokens/symbol 仅服务 TS 符号断言, 本分支
 * 不做符号断言故不保留死参。
 * @param goal 任务目标 (写入注释便于追溯)
 * @param module 目标模块文件名 (与 Python 路径同一 module 名)
 * @returns .test.ts 文件内容 */
export function tsAcceptanceBody(goal: string, module: string): string {
  return [
    '// 自动验收测试 — 由 mission.goal 确定性生成 (无 LLM 模板)。',
    '//',
    `// goal: ${goal}`,
    '// 作用: 功能新增类任务防假收敛 — 目标模块文件不存在时本测试失败, 使基线变红,',
    '//      给信息素循环真实驱动信号; 文件落地后本测试转绿参与收敛判定。',
    "import { existsSync } from 'node:fs'",
    "import { resolve } from 'node:path'",
    '',
    "describe('auto acceptance (goal-derived)', () => {",
    "  it('goal 要求的模块文件存在', () => {",
    `    expect(existsSync(resolve(process.cwd(), '${module}.ts'))).toBe(true)`,
    '  })',
    '})',
    '',
  ].join('\n')
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

/** 生成 <workdir>/.taiji/test_acceptance.{py|test.ts} (幂等: 内容一致不重写), 返回绝对路径。
 * node/ts 生态生成 .test.ts (文件存在断言), python/none 生态生成 .py (行为字节级不变)。
 * @param goal 任务目标
 * @param workdir 工作目录
 * @param eco 生态信息 (缺省时现场探测)
 * @returns 验收测试文件绝对路径 */
export function genAcceptanceTest(goal: string, workdir: string, eco?: EcosystemInfo): string {
  const tokens = acceptanceTokens(goal)
  const module = acceptanceIdent(acceptanceModuleName(goal) ?? tokens.join('_'))
  const symbol = acceptanceSymbolName(goal)
  const info = eco ?? probeEcosystem(workdir)
  const isTs = info.eco === 'ts' || info.eco === 'node'
  const body = isTs ? tsAcceptanceBody(goal, module) : acceptanceBody(goal, module, tokens, symbol)
  const path = join(workdir, '.taiji', isTs ? 'test_acceptance.test.ts' : 'test_acceptance.py')
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path) || readFileSync(path, 'utf8') !== body) {
    writeFileSync(path, body, 'utf8')
  }
  return path
}

/** 把验收测试并入 verify (P1-⑦ 生态化): pytest 系直接追加路径 (python 生态字节级不变);
 * node/ts 生态 + .test.ts 文件 → vitest 追加 `--run` 单跑; 其余 node verify (jest 等) 直接
 * 追加路径 (保留原 verify 前缀, 单命令、无 `&&`, 免 shell 模式可跑, 走宿主仓库自身 runner)。
 * 追加的是相对 workdir 的路径 (rel), 与 pytest 分支一致 — runVerify 以 cwd=resolve(workdir)
 * 执行, 相对路径正确解析。
 * @param verify 原验收命令
 * @param acceptPath 验收测试文件绝对路径
 * @param workdir 工作目录
 * @param eco 生态信息 (缺省时现场探测)
 * @returns 拼接后的 verify 命令 */
export function verifyWithAcceptance(verify: string, acceptPath: string, workdir: string, eco?: EcosystemInfo): string {
  const rel = relative(workdir, acceptPath)
  const info = eco ?? probeEcosystem(workdir)
  const isTsAccept = acceptPath.endsWith('.test.ts') && (info.eco === 'ts' || info.eco === 'node')
  if (isTsAccept) {
    if (verify.includes('vitest')) return `${verify} --run ${rel}`
    return `${verify} ${rel}`
  }
  return verify.includes('pytest') ? `${verify} ${rel}` : `pytest -q ${rel} && ${verify}`
}

export async function delegate(
  ctx: Context,
  provider: string,
  label: string,
  prompt: string,
  parent: Agent,
  signal: AbortSignal,
  workdir: string = '.',
  sandbox: string = 'full',
): Promise<{ ok: boolean; out: string }> {
  if (provider === 'claude-code') {
    return delegateClaudeCli(prompt, workdir, signal, sandbox)
  }
  if (provider === 'codex') {
    return delegateCodexCli(prompt, workdir, signal, sandbox)
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
  // C11: onAbort 提升到外层作用域, finally 里移除监听 (旧实现从不移除)
  let onAbort: (() => void) | undefined
  try {
    // 有界等待: ACP/子代理通道挂起时秒级失败 (claude/codex CLI 通道已提前返回, 不走此处)
    let result: AcpStream
    try {
      result = await new Promise<AcpStream>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`ACP delegate timeout ${ACP_DELEGATE_TIMEOUT}ms`)),
          ACP_DELEGATE_TIMEOUT,
        )
        onAbort = () => { clearTimeout(t); reject(new Error('aborted')) }
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
    if (onAbort) signal.removeEventListener('abort', onAbort)
    await run.dispose().catch(() => {})
  }
}

/** claude CLI 权限参数 (C1): full → Edit Write; restrict → 只读 Read (去掉 Edit Write)。 */
export function claudeCliArgs(prompt: string, workdir: string, sandbox = 'full'): string[] {
  if (sandbox === 'restrict') return ['-p', prompt, '--allowedTools', 'Read', '--add-dir', workdir]
  return ['-p', prompt, '--allowedTools', 'Edit Write', '--add-dir', workdir]
}

/** claude CLI 直调 (绕过 SDK 集成层, 已验证 2026-09-01) */
async function delegateClaudeCli(
  prompt: string,
  workdir: string,
  signal: AbortSignal,
  sandbox: string = 'full',
): Promise<{ ok: boolean; out: string }> {
  const deepseekKey = process.env.DEEPSEEK_API_KEY ?? ''
  try {
    const { stdout, stderr } = await execFileAsync(
      'claude',
      claudeCliArgs(prompt, workdir, sandbox),
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

/** codex CLI 权限参数 (C1): full → danger-full-access + bypass; restrict → read-only 且不加 bypass。 */
export function codexCliArgs(prompt: string, lastMsgPath: string, sandbox = 'full'): string[] {
  if (sandbox === 'restrict') {
    return ['exec', '-s', 'read-only', '--skip-git-repo-check', '--output-last-message', lastMsgPath, prompt]
  }
  return ['exec', '-s', 'danger-full-access',
    '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
    '--output-last-message', lastMsgPath, prompt]
}

/** codex CLI 直调 (2026-09-08 根治: dsh subagent-codex 经 SDK/app-server 桥在本容器返回
 * invalid-result 零输出 — 与 claude SDK 桥同病。codex exec 直调 + danger-full-access
 * (config.toml 已改) 实测可真实执行 shell, 不再依赖 bubblewrap/user namespaces)。 */
export async function delegateCodexCli(
  prompt: string,
  workdir: string,
  signal: AbortSignal,
  sandbox: string = 'full',
): Promise<{ ok: boolean; out: string }> {
  const deepseekKey = process.env.DEEPSEEK_API_KEY ?? ''
  // 2026-09-14: codex 对**较长回答**不把 agent message 写进 stdout (实测 ~80+ token 时
  // 只回显 prompt + token 统计 → "首个{到末个}"截到 prompt 里的 JSON 模板 → 解析必失败)。
  // 正解 = --output-last-message 落盘回读 (taiji 技能既有坑 2: 结论须落盘取)。
  // C11: 临时文件带 pid + 时间戳, 读完 last 后 finally unlink (不再泄漏)。
  const lastMsgPath = join(tmpdir(), `taiji-codex-${process.pid}-${Date.now()}.txt`)
  const readLast = (): string => {
    try {
      return existsSync(lastMsgPath) ? readFileSync(lastMsgPath, 'utf8').trim() : ''
    } catch { return '' }
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      'codex',
      codexCliArgs(prompt, lastMsgPath, sandbox),
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
  } finally {
    try { unlinkSync(lastMsgPath) } catch { /* 已不存在, 忽略 */ }
  }
}

/** pi 侦察蜂评审 (四维记分卡, 维度可配置) */
/** 从通道输出提取判定 JSON (2026-09-14 容错版)。

旧实现用"首个 { 到末个 }"截取 → 一旦输出里混入告警/示例 JSON (claude 的模型告警、
prompt 回显的 JSON 模板) 必然解析失败。这里扫描所有**括号平衡**的 {…} 片段, 逐个 JSON.parse,
返回第一个含必需字段的对象; 找不到返回 undefined (调用方按通道级失败处理)。
 */
export function extractJsonObject(text: string, requiredKeys: string[]): Record<string, unknown> | undefined {
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
      if (obj && typeof obj === 'object' && requiredKeys.every(k => k in obj)) return obj
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
export async function runReviewGate(
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

/** pi 通道失败 + 复审降级 (channel !== 'codex') → fail-closed: 不得标收敛。 */
export function isFailClosed(piFail: boolean, channel: string): boolean {
  return piFail && channel !== 'codex'
}

/** 收敛决策 (P0-⑥): 把 `if (g.converged)` 后的分支收拢为纯决策, 使 fail-closed 行为可单测。
 * 机械门硬 fail (gateBlocked) → 不收敛 + 含 "机械门FAIL" 文案 (优先于 fail-closed, 新证据优先);
 * fail-closed (pi 通道失败 + 复审降级) → 不收敛 + 含 "fail-closed" 文案 (调用方保守终止循环);
 * 否则 → 收敛 + PASS 文案。gate.converged 为 false 时返回空文案 (调用方不进此分支)。 */
export function resolveConvergence(
  gate: { converged: boolean; channel: string },
  piFail: boolean,
  gen: number,
  danger: number,
  gateBlocked?: boolean,
): { converged: boolean; finalState: string } {
  if (!gate.converged) return { converged: false, finalState: '' }
  if (gateBlocked) {
    return {
      converged: false,
      finalState: `第 ${gen} 代未收敛: 测试绿 + 机械门FAIL → 机械门硬 fail 阻断收敛`,
    }
  }
  if (isFailClosed(piFail, gate.channel)) {
    return {
      converged: false,
      finalState: `第 ${gen} 代未收敛: 测试绿 + pi通道失败 + 复审降级(${gate.channel}) → fail-closed`,
    }
  }
  return {
    converged: true,
    finalState: `第 ${gen} 代收敛: 测试绿 + danger=${piFail ? 'N/A(pi通道失败)' : danger} + ${gate.channel === 'codex' ? '复审' : `复审降级(${gate.channel})`} PASS`,
  }
}

/** 收敛证据链 (P1-D): 运行期逐项收集, 供调用方程序化核验"凭什么收敛"。
 * 纯函数 (无 ctx / 无 LLM / 无 IO): 只搬运运行期变量 + 派生确定性 reviewConfidence。 */
export interface ConvergenceEvidence {
  diffFiles: string[]
  verifyBefore: string
  verifyAfter: string
  gates: GateResult[]
  reviewChannel: string
  piFail: boolean
  reviewConfidence: number
  converged: boolean
}

/** verify 输出截断上限 (P1-D): 集中定义, 为 P2 外置留口。 */
const EVIDENCE_VERIFY_LIMIT = 2000

/** 构建收敛证据 (P1-D): 确定性纯函数, 同 input 两次调用输出完全一致 (可重放判据)。
 * reviewConfidence 三档规则 (非 LLM 打分):
 *   - channel==='codex' && !piFail → 1.0
 *   - piFail && channel!=='codex' → 0.3 (fail-closed 情形)
 *   - 其他降级 (channel!=='codex' && !piFail, 含 codex+piFail) → 0.5
 * verifyBefore/verifyAfter 超过 EVIDENCE_VERIFY_LIMIT 截断到 2000。 */
export function buildEvidence(input: {
  diffFiles: string[]
  verifyBefore: string
  verifyAfter: string
  gates: GateResult[]
  reviewChannel: string
  piFail: boolean
  converged: boolean
}): ConvergenceEvidence {
  const { diffFiles, verifyBefore, verifyAfter, gates, reviewChannel, piFail, converged } = input
  const reviewConfidence = reviewChannel === 'codex' && !piFail
    ? 1.0
    : piFail && reviewChannel !== 'codex'
      ? 0.3
      : 0.5
  return {
    diffFiles,
    verifyBefore: verifyBefore.slice(0, EVIDENCE_VERIFY_LIMIT),
    verifyAfter: verifyAfter.slice(0, EVIDENCE_VERIFY_LIMIT),
    gates, reviewChannel, piFail, reviewConfidence, converged,
  }
}

/** runs 落盘记录 (P1-③): 纯函数组装 taijiRunInner 的 runs JSON 对象,
 * 抽离使「stats.reputation → runs JSON」可运行时断言 (非字符串证据)。
 * @param input 运行期变量 (reputation/experience 为首次派单注入因子, fingerprint 为任务指纹, 均缺省落 null)
 * @returns 与 taijiRunInner 内联对象逐字段一致的 runs 记录 */
export function buildRunsRecord(input: {
  goal: string
  workdir: string
  verify: string
  sandbox: string
  dims: string[] | undefined
  converged: boolean
  finalState: string
  rounds: Record<number, string>
  review: unknown
  reputation: unknown
  experience?: unknown
  fingerprint: unknown
  parallel?: unknown
  params: EffectiveParams
  evidence: unknown
}): Record<string, unknown> {
  const {
    goal, workdir, verify, sandbox, dims, converged, finalState, rounds,
    review, reputation, experience, fingerprint, parallel, params, evidence,
  } = input
  return {
    ts: Date.now(), goal, workdir, verify, sandbox, dims: dims ?? 'default',
    converged, finalState, roundsUsed: Object.keys(rounds).length,
    rounds, review: review ?? null,
    reputation: reputation ?? null,
    experience: experience ?? null,
    fingerprint: fingerprint ?? null,
    parallel: parallel ?? null,
    params,
    evidence: evidence ?? null,
  }
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
async function taijiRunInner(
  ctx: Context,
  args: TaijiArgs,
  parent: Agent,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const workdir = resolve(args.workdir)
  const warn: WarnFn = message => ctx.logger.warn(message)
  const ecoInfo = probeEcosystem(workdir)
  let verify = args.verify || ecoInfo.defaultVerify
  const maxRounds = args.rounds ?? MAX_ROUNDS_DEFAULT
  const goal = args.goal
  const dims = args.danger_dimensions
  const sandbox = args.sandbox ?? 'full'   // full=默认 / restrict=只读验证

  let pm = loadPheromones(workdir, warn)
  const rounds: Record<number, string> = {}
  let prevPassed = false
  let mechanicalGateBlock = false   // 机械门硬 fail → 即使测试绿也不收敛 (gen 循环内每代重置)
  let converged = false
  let finalState = ''
  const stats: Record<string, unknown> = { sandbox, dims: dims ?? 'default' }
  stats.ecosystem = ecoInfo.eco
  const fingerprint = taskFingerprint(goal, workdir)
  stats.fingerprint = fingerprint
  stats.parallel = { used: false }
  let piBroken = false   // pi 通道失败一次后本轮跳过 (不再每代付 2min 超时)

  // P1-D: 收敛证据链"最新一代"快照 (循环外声明, 同 mechanicalGateBlock; 运行期逐代更新)
  let lastBaselineOut: string | undefined
  let lastConvergedOut: string | undefined
  let lastGates: GateResult[] | undefined
  let evidence: ConvergenceEvidence | undefined

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
      const acceptPath = genAcceptanceTest(goal, workdir, ecoInfo)
      verify = verifyWithAcceptance(verify, acceptPath, workdir, ecoInfo)
      stats.tdd_injected = acceptPath
      stats.verify_effective = verify
    } else {
      stats.tdd_skipped = 'baseline 非绿 (已有真实失败信号)'
    }
  }

  for (let gen = 1; gen <= maxRounds; gen++) {
    signal.throwIfAborted()
    mechanicalGateBlock = false
    pm = evaporate(loadPheromones(workdir, warn), prevPassed)

    // 测试
    const t = await runVerify(verify, workdir)
    lastBaselineOut = t.out
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
      if (sandbox === 'restrict') {
        // C1: restrict 只读 → 跳过修复循环 (不进入 delegate 写通道)
        rounds[gen] += ' | sandbox=restrict: 跳过修复(只读)'
        stats.sandbox_enforced = true
      } else {
        const target = auction(pm, workdir, gen, warn, undefined, fingerprint.bucket)
        stats.reputation = target?.reputation
        stats.experience = target?.experience
        if (target) {
          // P1-①: 多目标选择 — 第 N 个 agent 排除前 N-1 个 agent 已用文件, 打不同靶
          const usedFiles: string[] = []
          let activeFile = target.file
          let fixed = false
          let t2: { ok: boolean; out: string; code: number } | undefined
          // P2-③: 隔离并行 B — 触发条件全满足才并行, 否则原串行路径行为零变化
          const parallelEnabled = process.env.TAIJI_PARALLEL !== '0'
          const parallelEligible = parallelEnabled && target.agents.length >= 2 && activeFile !== '__project__'
          const gitTrack = parallelEligible ? await gitTrackStatus(workdir, activeFile) : 'tracked'
          const fallback = parallelFallbackReason(parallelEnabled, target.agents.length, activeFile, gitTrack)
          stats.parallel = fallback === undefined ? { used: false } : { used: false, fallback }
          let parallelStart = 0
          let parallelFixed = false
          if (fallback === undefined) {
            const stamp = Date.now()
            const note = resolvePrNote(pm, activeFile)
            const ctxNote = note ? `\n评审提示: ${note}` : ''
            const taskDesc = activeFile === '__project__' ? '项目整体' : activeFile
            const wts: Array<{ agent: string; provider: string; branch: string; path: string }> = []
            for (const agent of target.agents.slice(0, 2)) {
              const provider = PROVIDER_BY_AGENT[agent]
              if (!provider) break
              const branch = `taiji/${gen}-${agent}-${stamp}`
              const wt = await worktreeFor(workdir, `${gen}-${agent}`, branch)
              if (!wt.ok) break
              wts.push({ agent, provider, branch, path: wt.path })
            }
            if (wts.length < 2) {
              for (const w of wts) worktreeRemove(workdir, w.path, w.branch)
              rounds[gen] = (rounds[gen] ?? '') + ' | 并行: worktree 创建失败, 降级串行'
              stats.parallel = { used: false }
            } else {
              try {
                const prompt = `修复 ${taskDesc} 使验收命令 \`${verify}\` 通过。
任务: ${goal.slice(0, 400)}
${ctxNote}
测试失败详情:
${t.out.slice(-1500)}

输出要求: 实际编辑文件完成修复。完成后报告改了什么。`
                const results = await parallelAttempt({
                  agents: wts.map(w => ({ agent: w.agent, provider: w.provider, path: w.path })),
                  delegate: (provider, label, workdir) => delegate(ctx, provider, label, prompt, parent, signal, workdir, sandbox),
                  runVerify: workdir => runVerify(verify, workdir),
                })
                const winner = pickWinner(results)
                if (winner) {
                  const winnerWt = wts.find(w => w.agent === winner.agent)
                  const co = await checkoutFromWorktree(workdir, winnerWt?.path ?? '', activeFile)
                  if (!co.ok) rounds[gen] = (rounds[gen] ?? '') + ` | 并行: 回写失败 (${co.out})`
                  const t2main = await runVerify(verify, workdir)
                  lastConvergedOut = t2main.out
                  if (t2main.ok) {
                    t2 = t2main
                    rounds[gen] = (rounds[gen] ?? '') + ` | 并行: ${winner.agent}绿 → 胜出`
                    const changedFiles = await getChangedFiles(workdir)
                    const failedFiles = failedFilesFromOutput(t.out)
                    const losers = wts.map(w => w.agent).filter(a => a !== winner.agent)
                    const { hasChange } = recordParallelSignals({
                      winner: winner.agent,
                      losers,
                      bucket: fingerprint.bucket,
                      workdir,
                      changedFiles,
                      failedFiles,
                      rOk: true,
                      t2Ok: true,
                      warn,
                      updateAgentWeight,
                      recordReputation,
                      recordExperience,
                    })
                    if (!hasChange) rounds[gen] = (rounds[gen] ?? '') + ' | 零变更门: 无相关变更, 权重不增'
                    const gates = await mechanicalGates({
                      workdir,
                      diffFiles: changedFiles,
                      failedFiles,
                      verify,
                      tsconfigAvailable: existsSync(join(workdir, 'tsconfig.json')),
                    })
                    stats.gates = gates
                    lastGates = gates
                    const hardFail = gates.filter(g => !g.ok && !g.detail.includes('warn-level'))
                    if (hardFail.length > 0) {
                      rounds[gen] = (rounds[gen] ?? '') + ` | 机械门FAIL: ${hardFail.map(g => g.name).join(',')}`
                      mechanicalGateBlock = true
                    }
                    usedFiles.push(activeFile)
                    fixed = true
                    prevPassed = true
                    parallelFixed = true
                    stats.parallel = { used: true, winner: winner.agent, losers }
                  } else {
                    t2 = t2main
                    rounds[gen] = (rounds[gen] ?? '') + ' | 并行: 主workdir复测红 (wt绿主红)'
                    usedFiles.push(activeFile)
                    parallelStart = 2
                    stats.parallel = { used: true, losers: results.map(x => x.agent) }
                  }
                } else {
                  t2 = t
                  rounds[gen] = (rounds[gen] ?? '') + ' | 并行: 双红 → 无人胜出'
                  usedFiles.push(activeFile)
                  parallelStart = 2
                  stats.parallel = { used: true, losers: results.map(x => x.agent) }
                }
              } finally {
                for (const w of wts) worktreeRemove(workdir, w.path, w.branch)
              }
            }
          }
          for (const agent of (parallelFixed ? [] : target.agents.slice(parallelStart))) {
            const provider = PROVIDER_BY_AGENT[agent]
            if (!provider) {
              rounds[gen] += ` | 无 provider: ${agent}`
              continue
            }
            // 第 2+ 个 agent: 换靶 (排除前面用过的文件); 无替代文件时降级打同文件
            if (usedFiles.length > 0) {
              const alt = auction(pm, workdir, gen, warn, usedFiles)
              if (alt && alt.file !== activeFile) {
                activeFile = alt.file
                rounds[gen] += ` | ${agent} 换靶: ${activeFile} (多目标)`
              }
            }
            const note = resolvePrNote(pm, activeFile)
            const ctxNote = note ? `\n评审提示: ${note}` : ''
            const taskDesc = `${activeFile === '__project__' ? '项目整体' : activeFile}`
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
              sandbox,
            )
            rounds[gen] += ` | ${agent}修复 ${r.ok ? 'ok' : `失败: ${r.out.slice(0, 120)}`}`
            // 修复后复测 (C3: 权重信号移至复测之后, 以复测结果为准; 委派失败不双计)
            t2 = await runVerify(verify, workdir)
            lastConvergedOut = t2.out
            rounds[gen] += ` | ${agent}复测 ${t2.ok ? '绿 ✓' : '仍红'}`
            // P0-⑥: 零变更门 — 三条件齐才计权重 (git 有变更 + 与失败文件相交 + t2.ok)
            const changedFiles = await getChangedFiles(workdir)
            const failedFiles = failedFilesFromOutput(t.out)
            const hasChange = hasRelevantChange(changedFiles, failedFiles)
            const weightDelta = hasChange ? agentWeightDelta(r.ok, t2) : 0
            if (!hasChange && t2.ok) {
              rounds[gen] += ' | 零变更门: 无相关变更, 权重不增'
            }
            updateAgentWeight(workdir, agent, weightDelta, warn)
            // P1-③: 全局信誉 (与 P0-⑥ 零变更门同信号源: win = 复测绿 + 相关变更, 其余一律 loss)
            recordReputation(agent, t2.ok && weightDelta > 0, warn)
            // P2-②: 抽象经验 (桶级统计, 与 P1-③ 全局信誉同信号源: win = 复测绿 + 相关变更)
            recordExperience(fingerprint.bucket, agent, t2.ok && weightDelta > 0, warn)
            // P1-C: 异源机械判官层 — 零变更门之后接线 (diffFiles 非空但含禁止模式/工具链缺失等硬 fail)
            const gates = await mechanicalGates({
              workdir,
              diffFiles: changedFiles,
              failedFiles,
              verify,
              tsconfigAvailable: existsSync(join(workdir, 'tsconfig.json')),
            })
            stats.gates = gates
            lastGates = gates
            const hardFail = gates.filter(g => !g.ok && !g.detail.includes('warn-level'))
            if (hardFail.length > 0 && t2.ok) {
              rounds[gen] += ` | 机械门FAIL: ${hardFail.map(g => g.name).join(',')}`
              mechanicalGateBlock = true
            }
            if (t2.ok) {
              usedFiles.push(activeFile)
              fixed = true
              prevPassed = true
              break
            }
            usedFiles.push(activeFile)
            prevPassed = false
            signal.throwIfAborted()
          }
          if (t2 === undefined) {
            // C10: 全通道不可用 → 只记日志, 不再二次 sprayWeighted (首轮测试红已喷洒)
            rounds[gen] += ' | 所有通道均不可用'
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
                const rc = resolveConvergence(g, piFail, gen, review.danger, mechanicalGateBlock)
                converged = rc.converged
                finalState = rc.finalState
                if (converged) {
                  evidence = buildEvidence({
                    diffFiles: await getChangedFiles(workdir),
                    verifyBefore: lastBaselineOut ?? '',
                    verifyAfter: lastConvergedOut ?? '',
                    gates: lastGates ?? [],
                    reviewChannel: g.channel,
                    piFail,
                    converged: true,
                  })
                }
                break
              }
              if (g.stop) {
                finalState = g.finalState
                break
              }
              // 真实 FAIL (任意可用通道) → 回灌信息素
              pm = setProjectNote(pm, `[复审FAIL] ${g.summary.slice(0, 300)}`, { Pe: 30, Pr: 20 })
              savePheromones(workdir, pm)
            } else {
              // danger 过高 (pi 通道正常) → 喷洒评审意见
              pm = setProjectNote(pm, review.suggestions.slice(0, 300), { Pe: 0, Pr: 20 })
              savePheromones(workdir, pm)
            }
          }
        } else {
          rounds[gen] += ' | 无候选 (信息素为空)'
        }
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
          const rc = resolveConvergence(g, piFail, gen, review.danger, mechanicalGateBlock)
          converged = rc.converged
          finalState = rc.finalState
          if (converged) {
            evidence = buildEvidence({
              diffFiles: await getChangedFiles(workdir),
              verifyBefore: lastBaselineOut ?? '',
              verifyAfter: lastConvergedOut ?? '',
              gates: lastGates ?? [],
              reviewChannel: g.channel,
              piFail,
              converged: true,
            })
          }
          break
        }
        if (g.stop) {
          finalState = g.finalState
          break
        }
        pm = setProjectNote(pm, `[复审FAIL] ${g.summary.slice(0, 300)}`, { Pe: 30, Pr: 20 })
        savePheromones(workdir, pm)
      } else {
        // danger 过高 (pi 正常) → 喷洒意见并继续 (防静默空转), 由修复通道处理
        pm = setProjectNote(pm, review.suggestions.slice(0, 300), { Pe: 30, Pr: 20 })
        savePheromones(workdir, pm)
      }
    }

    if (gen === maxRounds) {
      finalState = `⛔ ${maxRounds} 代未收敛, 熔断保护`
    }
  }

  // P1-⑤: 循环结束 (runs 落盘前) 记录信息素终态分布 + agent 权重终态
  stats.distribution = pheromoneDistribution(loadPheromones(workdir, warn))
  stats.weights = loadAgentWeights(workdir, warn)

  // 运行日志落盘 (2026-09-08 可观测性: rounds/复审通道不再只在返回值一行渲染里, 事后可还原)
  try {
    const runsDir = join(workdir, '.taiji', 'runs')
    mkdirSync(runsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(
      join(runsDir, `run-${stamp}.json`),
      JSON.stringify(buildRunsRecord({
        goal, workdir, verify, sandbox, dims,
        converged, finalState, rounds,
        review: stats.review,
        reputation: stats.reputation,
        experience: stats.experience,
        fingerprint,
        parallel: stats.parallel,
        params: effectiveParams(),
        evidence,
      }), null, 2),
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
    evidence: evidence ?? null,
  }
}

/** 同目录并发互斥锁 (C9): 每个 workdir 一条 promise 链, 串行化 taijiRunInner。 */
const taijiLocks = new Map<string, Promise<unknown>>()

/** 太极主循环入口 (C9): 整个主循环体包进 per-workdir promise 链, 锁本身不进 stats。 */
export async function taijiRun(
  ctx: Context,
  args: TaijiArgs,
  parent: Agent,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const workdir = resolve(args.workdir)
  const run = (): Promise<Record<string, unknown>> => taijiRunInner(ctx, args, parent, signal)
  const prev = taijiLocks.get(workdir) ?? Promise.resolve()
  const cur = prev.then(run, run)
  taijiLocks.set(workdir, cur.finally(() => {}))
  return cur
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
        description: '验收命令, 缺省按生态探测 (node→<mgr> test, python→pytest -q, 无→echo)。',
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
          evidence: { type: 'json' },
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
      stats: JsonValue
      evidence: JsonValue
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
        stats: (r.stats ?? {}) as JsonValue,
        evidence: (r.evidence ?? null) as JsonValue,
      }
    },
  }))
  ctx.logger.info('[dsh-tool-taiji] 太极调度工具已注册 (taiji_run)')
}
