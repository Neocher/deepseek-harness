import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs, { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, mkdirSync, statSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
import {
  claudeCliArgs,
  codexCliArgs,
  runVerify,
  agentWeightDelta,
  updateAgentWeight,
  loadAgentWeights,
  atomicWriteJson,
  loadPheromones,
  extractJsonObject,
  bidJitter,
  fnv1a,
  auction,
  failedFilesFromOutput,
  getChangedFiles,
  hasRelevantChange,
  filesIntersect,
  mechanicalGates,
  isFailClosed,
  resolveConvergence,
  resolvePrNote,
  setProjectNote,
  buildEvidence,
  buildRunsRecord,
  probeEcosystem,
  tsAcceptanceBody,
  genAcceptanceTest,
  verifyWithAcceptance,
  effectiveParams,
  pheromoneDistribution,
  globalRepPath,
  globalRepDisabled,
  loadGlobalReputation,
  recordReputation,
  applyReputation,
  repFactor,
  streakPenalty,
  taskFingerprint,
  expPath,
  experienceDisabled,
  loadExperience,
  recordExperience,
  applyExperience,
  expFactor,
  worktreeFor,
  worktreeRemove,
  checkoutFromWorktree,
  pickWinner,
  parallelFallbackReason,
  recordParallelSignals,
  parallelAttempt,
} from '../src/index.js'

let td: string
beforeEach(() => {
  td = mkdtempSync(join(tmpdir(), 'taiji-test-'))
  // 全局信誉文件路径注入 tmp 目录 (隔离, 不写真实 ~/.taiji)
  process.env.TAIJI_GLOBAL_REP = join(td, 'global-agent-reputation.json')
  // 经验文件路径注入 tmp 目录 (隔离, 不写真实 ~/.taiji)
  process.env.TAIJI_EXP = join(td, 'global-experience.json')
})
afterEach(() => {
  rmSync(td, { recursive: true, force: true })
  delete process.env.TAIJI_GLOBAL_REP
  delete process.env.TAIJI_EXP
  delete process.env.TAIJI_VERIFY_SHELL_OK
  delete process.env.TAIJI_RANDOM_BID
  delete process.env.TAIJI_FAILED_FILE_RE
  delete process.env.TAIJI_TSC_BIN
  delete process.env.TAIJI_DANGER_THRESHOLD
  delete process.env.TAIJI_SPRAY_FILE_PE
  delete process.env.TAIJI_AUTO_TDD
  delete process.env.TAIJI_PARALLEL
})

/** C1: sandbox 分级 */
describe('C1 sandbox 权限分级', () => {
  it('claude restrict → 只读 Read, 无 Edit Write', () => {
    const a = claudeCliArgs('hi', '/x', 'restrict')
    expect(a).toContain('Read')
    expect(a).not.toContain('Edit Write')
  })
  it('claude full → Edit Write (旧行为)', () => {
    expect(claudeCliArgs('hi', '/x')).toContain('Edit Write')
  })
  it('codex restrict → read-only 且无 bypass', () => {
    const a = codexCliArgs('hi', '/last.txt', 'restrict')
    expect(a).toContain('read-only')
    expect(a).not.toContain('danger-full-access')
    expect(a).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })
  it('codex full → danger-full-access + bypass (旧行为)', () => {
    const a = codexCliArgs('hi', '/last.txt')
    expect(a).toContain('danger-full-access')
    expect(a).toContain('--dangerously-bypass-approvals-and-sandbox')
  })
})

/** C2: verify 参数化 */
describe('C2 verify 免 shell 元字符', () => {
  it('含 ; 被拒 (skipped)', async () => {
    const r = await runVerify('pytest -q; rm -rf /', td)
    expect(r.ok).toBe(false)
    expect(r.skipped).toBe(true)
    expect(r.out).toContain(';')
  })
  it('含 | 被拒', async () => {
    const r = await runVerify('pytest -q | cat', td)
    expect(r.ok).toBe(false)
    expect(r.skipped).toBe(true)
  })
  it('含 $() 被拒', async () => {
    const r = await runVerify('echo $(whoami)', td)
    expect(r.ok).toBe(false)
    expect(r.skipped).toBe(true)
  })
  it('干净命令正常执行', async () => {
    const r = await runVerify('true', td)
    expect(r.ok).toBe(true)
    expect(r.code).toBe(0)
  })
  it('失败的干净命令返回 code!=0 不 skipped', async () => {
    const r = await runVerify('false', td)
    expect(r.ok).toBe(false)
    expect(r.skipped).toBeUndefined()
    expect(r.code).not.toBe(0)
  })
  it('TAIJI_VERIFY_SHELL_OK=1 放行旧行为', async () => {
    process.env.TAIJI_VERIFY_SHELL_OK = '1'
    const r = await runVerify('true && true', td)
    expect(r.ok).toBe(true)
  })
})

/** C3: 权重信号 = 复测结果 */
describe('C3 权重信号修正', () => {
  it('委派失败 → 0 (不双计)', () => {
    expect(agentWeightDelta(false, { ok: true })).toBe(0)
    expect(agentWeightDelta(false, { ok: false })).toBe(0)
  })
  it('复测绿 → +1', () => {
    expect(agentWeightDelta(true, { ok: true })).toBe(1)
  })
  it('复测红 → -1', () => {
    expect(agentWeightDelta(true, { ok: false })).toBe(-1)
  })
  it('未复测 → -1', () => {
    expect(agentWeightDelta(true, undefined)).toBe(-1)
  })
  it('updateAgentWeight 落盘: delta 生效且旧值按 0.9 衰减', () => {
    atomicWriteJson(join(td, '.taiji/agent-weights.json'), { claude_code: 5, opencode: 2 })
    updateAgentWeight(td, 'claude_code', 1, () => {})
    const w = loadAgentWeights(td, () => {})
    expect(w.claude_code).toBeCloseTo(5 * 0.9 + 1, 3)
    expect(w.opencode).toBeCloseTo(2 * 0.9, 3)
  })
})

/** C4: 原子写 + 损坏备份 */
describe('C4 原子写与损坏备份', () => {
  it('atomicWriteJson 正常写盘可读回', () => {
    const p = join(td, 'sub/x.json')
    atomicWriteJson(p, { a: 1 })
    expect(JSON.parse(readFileSync(p, 'utf-8'))).toEqual({ a: 1 })
  })
  it('原子写后无 .tmp- 残留', () => {
    const p = join(td, 'y.json')
    atomicWriteJson(p, { b: 2 })
    expect(readdirSync(td)).toEqual(['y.json'])
  })
  it('损坏 pheromones → .corrupt-* 备份 + 告警 + 空重建', () => {
    const p = join(td, '.taiji/pheromones.json')
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, '{broken')
    const warns: string[] = []
    const pm = loadPheromones(td, m => warns.push(m))
    expect(pm).toEqual({})
    expect(warns.some(w => w.includes('损坏'))).toBe(true)
    const corrupts = readdirSync(join(td, '.taiji')).filter((f: string) => f.includes('.corrupt-'))
    expect(corrupts.length).toBe(1)
    expect(existsSync(p)).toBe(false)
  })
  it('损坏 agent-weights → 备份 + 空重建', () => {
    const p = join(td, '.taiji/agent-weights.json')
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, 'not-json')
    const warns: string[] = []
    const w = loadAgentWeights(td, m => warns.push(m))
    expect(w).toEqual({})
    expect(readdirSync(join(td, '.taiji')).some((f: string) => f.includes('.corrupt-'))).toBe(true)
  })
})

/** C5: 必需字段 .every */
describe('C5 extractJsonObject 必需字段', () => {
  it('残缺 JSON (缺 passed) → undefined (走通道降级, 不再误判 FAIL)', () => {
    expect(extractJsonObject('{"summary": "x"}', ['passed', 'summary'])).toBeUndefined()
  })
  it('完整 JSON → 返回对象', () => {
    expect(extractJsonObject('{"passed": true, "summary": "x"}', ['passed', 'summary'])).toEqual({
      passed: true,
      summary: 'x',
    })
  })
  it('首个候选残缺但第二个完整 → 取第二个', () => {
    const txt = '{"summary": "x"} noise {"passed": false, "summary": "y"}'
    expect(extractJsonObject(txt, ['passed', 'summary'])).toEqual({ passed: false, summary: 'y' })
  })
})

/** C6: 确定性抖动 */
describe('C6 确定性竞标抖动', () => {
  it('同 seed → 同 jitter', () => {
    expect(bidJitter('w\\0f\\0a\\01')).toBe(bidJitter('w\\0f\\0a\\01'))
  })
  it('fnv1a 确定性且不同输入不同值', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'))
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'))
  })
  it('jitter 落在 [0,1)', () => {
    for (let i = 0; i < 20; i++) {
      const j = bidJitter(`seed-${i}`)
      expect(j).toBeGreaterThanOrEqual(0)
      expect(j).toBeLessThan(1)
    }
  })
  it('TAIJI_RANDOM_BID=1 → 随机 (分布不同)', () => {
    process.env.TAIJI_RANDOM_BID = '1'
    const vals = new Set(Array.from({ length: 30 }, () => bidJitter('same-seed')))
    expect(vals.size).toBeGreaterThan(1)
  })
})

/** C8: 失败文件多语言解析 */
describe('C8 failedFilesFromOutput 多语言', () => {
  it('.py 格式', () => {
    const out = 'FAILED tests/test_foo.py::test_x - assert 1 == 2\ntests/test_foo.py:12: in test_x'
    const f = failedFilesFromOutput(out)
    expect(f).toContain('tests/test_foo.py')
  })
  it('jest FAIL 格式', () => {
    const f = failedFilesFromOutput('FAIL src/__tests__/bar.test.ts\n  ● bar > fails')
    expect(f).toContain('src/__tests__/bar.test.ts')
  })
  it('TS 编译器 error 格式', () => {
    const f = failedFilesFromOutput('src/app.tsx:10:5 - error TS2322: Type string is not assignable')
    expect(f).toContain('src/app.tsx')
  })
  it('Go 格式', () => {
    const f = failedFilesFromOutput('cmd/main.go:12:3: cannot use x as int')
    expect(f).toContain('cmd/main.go')
  })
  it('去重 + 上限 5', () => {
    let out = ''
    for (let i = 0; i < 10; i++) out += `tests/a_${i}.py:1: err\ntests/a_${i}.py:2: err\n`
    expect(failedFilesFromOutput(out).length).toBeLessThanOrEqual(5)
  })
  it('TAIJI_FAILED_FILE_RE 覆盖', () => {
    process.env.TAIJI_FAILED_FILE_RE = 'BROKEN:([A-Za-z0-9_/.]+)'
    const f = failedFilesFromOutput('BROKEN:custom/mod.rs ok')
    expect(f).toContain('custom/mod.rs')
  })
})

/** C10: 全通道不可用不再二次喷洒 (代码结构断言) */
describe('C10 消除重复喷洒', () => {
  it('全通道分支只记日志: src 中 t2===undefined 分支无 sprayWeighted 调用', async () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    const idx = src.indexOf('t2 === undefined')
    expect(idx).toBeGreaterThan(-1)
    const seg = src.slice(idx, idx + 400)
    // 分支内 (到下一个 else) 不应再出现 sprayWeighted 调用
    const segBeforeElse = seg.slice(0, seg.indexOf('} else if'))
    expect(segBeforeElse).not.toContain('sprayWeighted(')
  })
})

/** C11: signal 监听移除 + 临时文件命名 */
describe('C11 资源清理 (结构断言)', () => {
  it('delegate 的 finally 移除 abort 监听', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toContain("signal.removeEventListener('abort', onAbort)")
  })
  it('codex 临时文件带 pid 且读后 unlink', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toContain('taiji-codex-${process.pid}-')
    expect(src).toContain('unlinkSync(lastMsgPath)')
  })
})

/** C9: 互斥锁结构 */
describe('C9 per-workdir 互斥', () => {
  it('taijiRun 经 taijiLocks 串行化 (结构断言)', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toContain('const taijiLocks = new Map<string, Promise<unknown>>()')
    expect(src).toContain('taijiLocks.get(workdir)')
    expect(src).toContain('taijiLocks.set(workdir, cur')
  })
})

/** C7: execute 返回 stats */
describe('C7 execute 返回 stats', () => {
  it('execute 返回对象含 stats 字段 (结构断言)', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toMatch(/stats:\s*\(r\.stats \?\? \{\}\)/)
  })
})

/** P0-6: getChangedFiles 零变更门输入 */
describe('P0-6 getChangedFiles 变更文件提取', () => {
  it('git repo: modified + untracked 文件名都被正确返回 (非 .py 残片)', async () => {
    execFileSync('git', ['init', '-q', td])
    execFileSync('git', ['-C', td, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', td, 'config', 'user.name', 'Test'])
    writeFileSync(join(td, 'a.py'), 'v1\n')
    execFileSync('git', ['-C', td, 'add', 'a.py'])
    execFileSync('git', ['-C', td, 'commit', '-qm', 'init'])
    writeFileSync(join(td, 'a.py'), 'v2\n')   // modified
    writeFileSync(join(td, 'b.py'), 'new\n')  // untracked
    const files = await getChangedFiles(td)
    expect(files).toContain('a.py')
    expect(files).toContain('b.py')
    expect(files).not.toContain('.py')
    expect(files).not.toContain('a')
  })
  it('非 git 仓库 → []', async () => {
    writeFileSync(join(td, 'x.txt'), 'hi')
    expect(await getChangedFiles(td)).toEqual([])
  })
})

/** P0-6: hasRelevantChange 相交判定 */
describe('P0-6 hasRelevantChange 零变更门相交判定', () => {
  it('无变更 → false', () => {
    expect(hasRelevantChange([], ['a.py'])).toBe(false)
  })
  it('无关变更 → false', () => {
    expect(hasRelevantChange(['b.py'], ['a.py'])).toBe(false)
  })
  it('相关变更 (精确 / 双向 substring) → true', () => {
    expect(hasRelevantChange(['a.py'], ['a.py'])).toBe(true)
    expect(hasRelevantChange(['src/a.py'], ['a.py'])).toBe(true)
    expect(hasRelevantChange(['a.py'], ['src/a.py'])).toBe(true)
  })
  it('空 failedFiles 降级 → 只看 changed 非空', () => {
    expect(hasRelevantChange(['a.py'], [])).toBe(true)
    expect(hasRelevantChange([], [])).toBe(false)
  })
})

/** P0-6: isFailClosed fail-closed 判定 */
describe('P0-6 isFailClosed pi 通道失败 + 降级', () => {
  it('(true, opencode) → true', () => {
    expect(isFailClosed(true, 'opencode')).toBe(true)
  })
  it('(true, codex) → false (正常路径不受影响)', () => {
    expect(isFailClosed(true, 'codex')).toBe(false)
  })
  it('(false, opencode) → false', () => {
    expect(isFailClosed(false, 'opencode')).toBe(false)
  })
})

/** P0-6: resolveConvergence 收敛决策 (fail-closed 行为断言) */
describe('P0-6 resolveConvergence 收敛决策', () => {
  it('pi通道失败 + 复审降级 → converged=false + finalState 含 fail-closed', () => {
    const rc = resolveConvergence({ converged: true, channel: 'opencode' }, true, 2, 40)
    expect(rc.converged).toBe(false)
    expect(rc.finalState).toContain('fail-closed')
    expect(rc.finalState).toContain('未收敛')
  })
  it('pi通道失败 + codex 通道 → converged=true + PASS (正常路径不受影响)', () => {
    const rc = resolveConvergence({ converged: true, channel: 'codex' }, true, 2, 40)
    expect(rc.converged).toBe(true)
    expect(rc.finalState).toContain('PASS')
    expect(rc.finalState).not.toContain('fail-closed')
  })
  it('pi正常 + 复审降级 → converged=true', () => {
    const rc = resolveConvergence({ converged: true, channel: 'opencode' }, false, 2, 30)
    expect(rc.converged).toBe(true)
    expect(rc.finalState).toContain('danger=30')
    expect(rc.finalState).toContain('PASS')
  })
  it('gate.converged=false → converged=false + 空 finalState (不进收敛分支)', () => {
    const rc = resolveConvergence({ converged: false, channel: 'opencode' }, true, 2, 40)
    expect(rc.converged).toBe(false)
    expect(rc.finalState).toBe('')
  })
  it('结构断言: 两处 if(g.converged) 块内紧随 break, 不落到 [复审FAIL] 喷洒', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    const matches = [...src.matchAll(/if \(g\.converged\) \{/g)]
    expect(matches.length).toBe(2)
    for (const m of matches) {
      const idx = m.index ?? 0
      const stopIdx = src.indexOf('if (g.stop)', idx)
      expect(stopIdx).toBeGreaterThan(idx)
      const block = src.slice(idx, stopIdx)
      // 块内必须 resolveConvergence + break (保守终止), 不能穿透到 g.stop 之后的 [复审FAIL] 喷洒
      expect(block).toContain('resolveConvergence(g, piFail, gen, review.danger, mechanicalGateBlock)')
      expect(block).toContain('break')
      expect(block).not.toContain('[复审FAIL]')
    }
  })
})

/** P1-2: Pr_note 写读键断链修复 */
describe('P1-2 Pr_note 写读键断链', () => {
  it('setProjectNote 保留累计 Pe/Pr; 首次 (零值) 应用 base; base 缺省不改变零值 (AC-1/AC-2)', () => {
    const kept = setProjectNote(
      { __project__: { Pe: 20, Pr: 10, complexity: 30 } },
      'note',
      { Pe: 30, Pr: 20 },
    )
    expect(kept.__project__?.Pe).toBe(20)
    expect(kept.__project__?.Pr).toBe(10)
    expect(kept.__project__?.Pr_note).toBe('note')

    const withBase = setProjectNote({}, 'note', { Pe: 30, Pr: 20 })
    expect(withBase.__project__?.Pe).toBe(30)
    expect(withBase.__project__?.Pr).toBe(20)
    expect(withBase.__project__?.Pr_note).toBe('note')

    const noBase = setProjectNote({}, 'note')
    expect(noBase.__project__?.Pe).toBe(0)
    expect(noBase.__project__?.Pr).toBe(0)
    expect(noBase.__project__?.complexity).toBe(30)
    expect(noBase.__project__?.Pr_note).toBe('note')
  })
  it('读端 fallback: 文件无 note + __project__ 有 note → 命中全局 (AC-3)', () => {
    const pm = {
      foo: { Pe: 0, Pr: 0, complexity: 0 },
      __project__: { Pe: 0, Pr: 0, complexity: 30, Pr_note: 'G' },
    }
    expect(resolvePrNote(pm, 'foo')).toBe('G')
  })
  it('读端优先级: 文件自身有 note → 用文件的不用全局 (AC-4)', () => {
    const pm = {
      foo: { Pe: 0, Pr: 0, complexity: 0, Pr_note: 'F' },
      __project__: { Pe: 0, Pr: 0, complexity: 30, Pr_note: 'G' },
    }
    expect(resolvePrNote(pm, 'foo')).toBe('F')
  })
})

/** P1-C: 异源机械判官层 */
describe('P1-C 机械判官层', () => {
  it('filesIntersect: 双向 substring 相交判定', () => {
    expect(filesIntersect(['a.py'], ['a.py'])).toBe(true)
    expect(filesIntersect(['src/a.py'], ['a.py'])).toBe(true)
    expect(filesIntersect(['a.py'], ['src/a.py'])).toBe(true)
    expect(filesIntersect(['a.py'], ['b.py'])).toBe(false)
    expect(filesIntersect([], ['a.py'])).toBe(false)
  })

  it('gate-zero-change: 空 diffFiles fail / 非空 ok', async () => {
    const empty = await mechanicalGates({ workdir: td, diffFiles: [], failedFiles: [], verify: 'pytest -q' })
    expect(empty[0]?.name).toBe('gate-zero-change')
    expect(empty[0]?.ok).toBe(false)
    expect(empty[0]?.detail).toContain('0')

    const nonEmpty = await mechanicalGates({ workdir: td, diffFiles: ['a.py'], failedFiles: [], verify: 'pytest -q' })
    expect(nonEmpty[0]?.ok).toBe(true)
  })

  it('gate-scope: 有交集 ok / 无交集 fail / 无 failedFiles 跳过', async () => {
    const hit = await mechanicalGates({ workdir: td, diffFiles: ['a.py'], failedFiles: ['a.py'], verify: 'pytest -q' })
    expect(hit[1]?.name).toBe('gate-scope')
    expect(hit[1]?.ok).toBe(true)

    const miss = await mechanicalGates({ workdir: td, diffFiles: ['a.py'], failedFiles: ['b.py'], verify: 'pytest -q' })
    expect(miss[1]?.ok).toBe(false)

    const none = await mechanicalGates({ workdir: td, diffFiles: ['a.py'], failedFiles: [], verify: 'pytest -q' })
    expect(none[1]?.ok).toBe(true)
    expect(none[1]?.detail).toContain('跳过')
  })

  it('gate-typecheck: 非 TS 生态跳过', async () => {
    const r = await mechanicalGates({ workdir: td, diffFiles: ['a.py'], failedFiles: [], verify: 'pytest -q', tsconfigAvailable: true })
    expect(r[2]?.name).toBe('gate-typecheck')
    expect(r[2]?.ok).toBe(true)
    expect(r[2]?.detail).toContain('非 TS 生态')
  })

  it('gate-typecheck: tsc 不可用 fail (detail 含 tsc 不可用)', async () => {
    process.env.TAIJI_TSC_BIN = 'definitely-missing-tsc-bin-xyz'
    const r = await mechanicalGates({ workdir: td, diffFiles: ['a.ts'], failedFiles: [], verify: 'pytest -q', tsconfigAvailable: true })
    expect(r[2]?.name).toBe('gate-typecheck')
    expect(r[2]?.ok).toBe(false)
    expect(r[2]?.detail).toContain('tsc 不可用')
  })

  it('gate-forbidden-patterns: 裸 except 命中 + 行号 (硬 fail, 无 warn-level)', async () => {
    writeFileSync(join(td, 'x.py'), 'def f():\n    try:\n        pass\n    except:\n        pass\n')
    const r = await mechanicalGates({ workdir: td, diffFiles: ['x.py'], failedFiles: [], verify: 'pytest -q' })
    expect(r[3]?.name).toBe('gate-forbidden-patterns')
    expect(r[3]?.ok).toBe(false)
    expect(r[3]?.detail).toContain('x.py:4')
    expect(r[3]?.detail).not.toContain('warn-level')
  })

  it('gate-forbidden-patterns: 空 catch 命中 + 行号', async () => {
    writeFileSync(join(td, 'y.ts'), 'try {\n  foo()\n} catch (e) {\n}\n')
    const r = await mechanicalGates({ workdir: td, diffFiles: ['y.ts'], failedFiles: [], verify: 'pytest -q' })
    expect(r[3]?.ok).toBe(false)
    expect(r[3]?.detail).toContain('y.ts:3')
    expect(r[3]?.detail).not.toContain('warn-level')
  })

  it('gate-forbidden-patterns: console.log 命中 detail 含 warn-level', async () => {
    writeFileSync(join(td, 'z.js'), 'function f() {\n  console.log("x")\n}\n')
    const r = await mechanicalGates({ workdir: td, diffFiles: ['z.js'], failedFiles: [], verify: 'pytest -q' })
    expect(r[3]?.ok).toBe(false)
    expect(r[3]?.detail).toContain('warn-level')
  })

  it('gate-forbidden-patterns: 干净文件 ok', async () => {
    writeFileSync(join(td, 'clean.ts'), 'export const x = 1\n')
    const r = await mechanicalGates({ workdir: td, diffFiles: ['clean.ts'], failedFiles: [], verify: 'pytest -q' })
    expect(r[3]?.ok).toBe(true)
    expect(r[3]?.detail).toContain('无禁止模式')
  })

  it('resolveConvergence: gateBlocked=true → converged=false + finalState 含 机械门FAIL', () => {
    const rc = resolveConvergence({ converged: true, channel: 'codex' }, false, 2, 30, true)
    expect(rc.converged).toBe(false)
    expect(rc.finalState).toContain('机械门FAIL')
  })

  it('resolveConvergence: gateBlocked 缺省 → 行为不变 (codex PASS)', () => {
    const rc = resolveConvergence({ converged: true, channel: 'codex' }, true, 2, 40)
    expect(rc.converged).toBe(true)
    expect(rc.finalState).toContain('PASS')
  })
})

/** P1-D: 收敛证据链 */
describe('P1-D 收敛证据链', () => {
  const input = {
    diffFiles: ['a.py', 'src/b.ts'],
    verifyBefore: 'baseline fail output',
    verifyAfter: 'converged pass output',
    gates: [
      { name: 'gate-zero-change', ok: true, detail: '变更文件 2 个' },
      { name: 'gate-scope', ok: true, detail: '变更与失败文件相交' },
    ],
    reviewChannel: 'codex',
    piFail: false,
    converged: true,
  }

  it('buildEvidence 确定性: 同 input 两次 → deep-equal 且 JSON 完全一致 (可重放判据)', () => {
    const a = buildEvidence(input)
    const b = buildEvidence(input)
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('reviewConfidence 三档确定性规则', () => {
    expect(buildEvidence({ ...input, reviewChannel: 'codex', piFail: false }).reviewConfidence).toBe(1.0)
    expect(buildEvidence({ ...input, reviewChannel: 'opencode', piFail: true }).reviewConfidence).toBe(0.3)
    expect(buildEvidence({ ...input, reviewChannel: 'claude-code', piFail: false }).reviewConfidence).toBe(0.5)
  })

  it('证据含全字段: diffFiles/gates/verifyBefore/verifyAfter/reviewChannel/piFail/converged 透传', () => {
    const e = buildEvidence(input)
    expect(e.diffFiles).toEqual(input.diffFiles)
    expect(e.gates).toEqual(input.gates)
    expect(e.verifyBefore).toBe(input.verifyBefore)
    expect(e.verifyAfter).toBe(input.verifyAfter)
    expect(e.reviewChannel).toBe(input.reviewChannel)
    expect(e.piFail).toBe(input.piFail)
    expect(e.converged).toBe(input.converged)
  })

  it('截断: verifyBefore/verifyAfter 超过 2000 → 截到 2000', () => {
    const long = 'x'.repeat(2500)
    const e = buildEvidence({ ...input, verifyBefore: long, verifyAfter: long })
    expect(e.verifyBefore).toHaveLength(2000)
    expect(e.verifyAfter).toHaveLength(2000)
    expect(e.verifyBefore).toBe('x'.repeat(2000))
  })

  it('接线语义 (结构断言): 收敛证据收集 + 落盘 + 返回值顶层接线', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toContain('export function buildEvidence(')
    expect(src).toContain('if (converged) {')
    expect(src).toContain('evidence = buildEvidence({')
    expect(src).toContain('lastBaselineOut = t.out')
    expect(src).toContain('lastConvergedOut = t2.out')
    expect(src).toContain('lastGates = gates')
    expect(src).toContain('evidence: evidence ?? null')
    expect(src).toContain('r.evidence ?? null')
  })
})

/** P1-7: 生态探测 + auto_tdd 生态化 */
describe('P1-7 probeEcosystem 生态探测', () => {
  it('pnpm-lock.yaml → node/pnpm + defaultVerify pnpm test', () => {
    writeFileSync(join(td, 'pnpm-lock.yaml'), '')
    expect(probeEcosystem(td)).toEqual({ eco: 'node', pkgManager: 'pnpm', defaultVerify: 'pnpm test' })
  })
  it('yarn.lock → node/yarn', () => {
    writeFileSync(join(td, 'yarn.lock'), '')
    expect(probeEcosystem(td)).toEqual({ eco: 'node', pkgManager: 'yarn', defaultVerify: 'yarn test' })
  })
  it('package-lock.json → node/npm', () => {
    writeFileSync(join(td, 'package-lock.json'), '')
    expect(probeEcosystem(td)).toEqual({ eco: 'node', pkgManager: 'npm', defaultVerify: 'npm test' })
  })
  it('pyproject.toml → python/pytest -q', () => {
    writeFileSync(join(td, 'pyproject.toml'), '')
    expect(probeEcosystem(td)).toEqual({ eco: 'python', defaultVerify: 'pytest -q' })
  })
  it('requirements.txt → python', () => {
    writeFileSync(join(td, 'requirements.txt'), '')
    expect(probeEcosystem(td).eco).toBe('python')
  })
  it('setup.py → python', () => {
    writeFileSync(join(td, 'setup.py'), '')
    expect(probeEcosystem(td).eco).toBe('python')
  })
  it('无文件 → none + echo', () => {
    expect(probeEcosystem(td)).toEqual({ eco: 'none', defaultVerify: 'echo "no ecosystem"' })
  })
  it('多 lockfile 并存 pnpm 优先', () => {
    writeFileSync(join(td, 'package-lock.json'), '')
    writeFileSync(join(td, 'yarn.lock'), '')
    writeFileSync(join(td, 'pnpm-lock.yaml'), '')
    expect(probeEcosystem(td).pkgManager).toBe('pnpm')
  })
  it('node lockfile 与 python 文件并存 → node', () => {
    writeFileSync(join(td, 'package-lock.json'), '')
    writeFileSync(join(td, 'pyproject.toml'), '')
    expect(probeEcosystem(td).eco).toBe('node')
  })
})

/** P1-7: tsAcceptanceBody TS 验收模板 */
describe('P1-7 tsAcceptanceBody TS 验收模板', () => {
  it('含 module 文件名 + existsSync 断言 + node:fs/node:path 导入', () => {
    const body = tsAcceptanceBody('实现 foo 模块', 'foo')
    expect(body).toContain("'foo.ts'")
    expect(body).toContain('existsSync')
    expect(body).toContain("from 'node:fs'")
    expect(body).toContain("from 'node:path'")
    expect(body).toContain('describe(')
  })
  it('不虚构 import 目标模块 (只导入 node 内置)', () => {
    const body = tsAcceptanceBody('实现 foo 模块', 'foo')
    expect(body).not.toContain('import foo')
    expect(body).not.toContain("from 'foo'")
    expect(body).toMatch(/import \{ existsSync \} from 'node:fs'/)
  })
})

/** P1-7: genAcceptanceTest 生态化 */
describe('P1-7 genAcceptanceTest 生态化', () => {
  it('node 生态 (pnpm-lock) 生成 .test.ts 而非 .py', () => {
    writeFileSync(join(td, 'pnpm-lock.yaml'), '')
    const path = genAcceptanceTest('实现 foo 模块', td)
    expect(path).toContain('test_acceptance.test.ts')
    expect(path).not.toContain('test_acceptance.py')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toContain('existsSync')
  })
  it('显式传 eco=node 即使无 lockfile 也生成 .test.ts', () => {
    const path = genAcceptanceTest('实现 foo 模块', td, { eco: 'node', pkgManager: 'pnpm', defaultVerify: 'pnpm test' })
    expect(path).toContain('test_acceptance.test.ts')
  })
  it('eco=ts 走 .test.ts 分支 (类型前瞻)', () => {
    const path = genAcceptanceTest('实现 foo 模块', td, { eco: 'ts', defaultVerify: 'pnpm test' })
    expect(path).toContain('test_acceptance.test.ts')
  })
  it('python 生态 (pyproject) 生成 .py + acceptanceBody 字节级不变', () => {
    writeFileSync(join(td, 'pyproject.toml'), '')
    const path = genAcceptanceTest('实现 foo 模块', td)
    expect(path).toContain('test_acceptance.py')
    const body = readFileSync(path, 'utf-8')
    expect(body).toContain('import foo')
    expect(body).toContain('def test_foo()')
    expect(body).toContain('hasattr(foo, "foo")')
  })
  it('TS 幂等: 内容一致不重写 (mtime 不被写操作覆盖)', () => {
    writeFileSync(join(td, 'pnpm-lock.yaml'), '')
    const p = genAcceptanceTest('实现 foo 模块', td)
    const past = new Date('2000-01-01T00:00:00Z')
    utimesSync(p, past, past)   // 回拨 mtime 到已知旧值, 消除对时钟/延时的依赖
    const mAfterSet = statSync(p).mtimeMs
    const p2 = genAcceptanceTest('实现 foo 模块', td)   // 内容一致 → 跳过写
    expect(p2).toBe(p)
    expect(statSync(p).mtimeMs).toBe(mAfterSet)   // 写操作未覆盖 mtime
  })
  it('TS 内容被篡改 → 重写恢复', () => {
    writeFileSync(join(td, 'pnpm-lock.yaml'), '')
    const p = genAcceptanceTest('实现 foo 模块', td)
    const correct = readFileSync(p, 'utf-8')
    writeFileSync(p, 'garbage')
    genAcceptanceTest('实现 foo 模块', td)
    expect(readFileSync(p, 'utf-8')).toBe(correct)
  })
})

/** P1-7: verifyWithAcceptance 生态化 */
describe('P1-7 verifyWithAcceptance 生态化', () => {
  const tsPath = () => join(td, '.taiji', 'test_acceptance.test.ts')
  const pyPath = () => join(td, '.taiji', 'test_acceptance.py')

  it('vitest verify + .test.ts → --run', () => {
    const v = verifyWithAcceptance('npx vitest', tsPath(), td, { eco: 'node', pkgManager: 'pnpm', defaultVerify: 'pnpm test' })
    expect(v).toBe('npx vitest --run .taiji/test_acceptance.test.ts')
  })
  it('jest verify → 保留原 verify 前缀追加路径', () => {
    expect(verifyWithAcceptance('npx jest', tsPath(), td, { eco: 'node', pkgManager: 'npm', defaultVerify: 'npm test' }))
      .toBe('npx jest .taiji/test_acceptance.test.ts')
    expect(verifyWithAcceptance('npx jest --coverage', tsPath(), td, { eco: 'node', pkgManager: 'npm', defaultVerify: 'npm test' }))
      .toBe('npx jest --coverage .taiji/test_acceptance.test.ts')
  })
  it('其余 node verify → 直接追加路径 (单命令无 &&, 免 shell 可跑)', () => {
    const v = verifyWithAcceptance('pnpm test', tsPath(), td, { eco: 'node', pkgManager: 'pnpm', defaultVerify: 'pnpm test' })
    expect(v).toBe('pnpm test .taiji/test_acceptance.test.ts')
  })
  it('pytest 系路径不变 (回归保护)', () => {
    expect(verifyWithAcceptance('pytest -q', pyPath(), td)).toBe('pytest -q .taiji/test_acceptance.py')
    expect(verifyWithAcceptance('npm test', pyPath(), td)).toBe('pytest -q .taiji/test_acceptance.py && npm test')
  })
})

/** P1-7: 主循环接线 (结构断言) */
describe('P1-7 主循环接线', () => {
  it('probeEcosystem + defaultVerify + stats.ecosystem + ecoInfo 透传', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toContain('const ecoInfo = probeEcosystem(workdir)')
    expect(src).toContain('let verify = args.verify || ecoInfo.defaultVerify')
    expect(src).toContain('stats.ecosystem = ecoInfo.eco')
    expect(src).toContain('genAcceptanceTest(goal, workdir, ecoInfo)')
    expect(src).toContain('verifyWithAcceptance(verify, acceptPath, workdir, ecoInfo)')
  })
})

/** P1-①: auction excludeFiles 多目标选择 (agent 打不同靶) */
describe('P1-① auction excludeFiles 多目标选择', () => {
  /** 三文件信息素地图: A(Pe=90) > B(Pe=60) > C(Pe=30), 刺激 = Pe (Pr=0)。 */
  const mkPm = (): Record<string, { Pe: number; Pr: number; complexity: number }> => ({
    'a.py': { Pe: 90, Pr: 0, complexity: 0 },
    'b.py': { Pe: 60, Pr: 0, complexity: 0 },
    'c.py': { Pe: 30, Pr: 0, complexity: 0 },
  })

  it('AC-1: 空 excludeFiles 与无参结果一致 (向后兼容回归)', () => {
    const pm = mkPm()
    const withEmpty = auction(pm, td, 1, () => {}, [])
    const without = auction(pm, td, 1, () => {})
    expect(withEmpty).toEqual(without)
    expect(withEmpty?.file).toBe('a.py')
  })

  it('AC-2: 排除 argmax 取次优 (守卫 && 优先级)', () => {
    const pm = mkPm()
    expect(auction(pm, td, 1, () => {}, ['a.py'])?.file).toBe('b.py')
    expect(auction(pm, td, 1, () => {}, ['a.py', 'b.py'])?.file).toBe('c.py')
  })

  it('AC-3: 排除所有候选 → undefined (降级到无候选)', () => {
    const pm = mkPm()
    expect(auction(pm, td, 1, () => {}, ['a.py', 'b.py', 'c.py'])).toBeUndefined()
  })

  it('AC-4: 主循环 activeFile/usedFiles 换靶接线 (结构断言)', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toContain('export function auction(')
    expect(src).toContain('excludeFiles?: string[]')
    expect(src).toContain('let activeFile = target.file')
    expect(src).toContain('const usedFiles: string[] = []')
    expect(src).toContain('auction(pm, workdir, gen, warn, usedFiles)')
    expect(src).toContain('换靶: ${activeFile} (多目标)')
    expect(src).toContain('resolvePrNote(pm, activeFile)')
    expect(src).toContain("const taskDesc = `${activeFile === '__project__'")
    // failedFilesFromOutput 仍读 baseline t.out (P0-⑥ 零变更门锚点不变)
    expect(src).toContain('const failedFiles = failedFilesFromOutput(t.out)')
  })
})

/** P1-⑤: 参数暴露 + 分布日志 */
describe('P1-⑤ 参数暴露 + 分布日志', () => {
  it('effectiveParams 默认值快照: 8 决策常量 + reviewChain/delegateTimeout/autoTdd (AC-2)', () => {
    const p = effectiveParams()
    expect(p.dangerThreshold).toBe(40)
    expect(p.maxRounds).toBe(4)
    expect(p.weightDecay).toBe(0.9)
    expect(p.sprayFilePe).toBe(30)
    expect(p.sprayGlobalPe).toBe(20)
    expect(p.peVaporGreen).toBe(0.5)
    expect(p.peVaporGen).toBe(0.8)
    expect(p.stimulusPrFactor).toBe(0.5)
    expect(p.reviewChain).toBe('codex,opencode,claude-code')
    expect(p.delegateTimeoutMs).toBe(120000)
    expect(p.autoTdd).toBe(true)
  })

  it('env 覆盖生效: TAIJI_DANGER_THRESHOLD/SPRAY_FILE_PE/AUTO_TDD → effectiveParams 读运行时 env (AC-2)', () => {
    process.env.TAIJI_DANGER_THRESHOLD = '55'
    process.env.TAIJI_SPRAY_FILE_PE = '77'
    process.env.TAIJI_AUTO_TDD = '0'
    const p = effectiveParams()
    expect(p.dangerThreshold).toBe(55)
    expect(p.sprayFilePe).toBe(77)
    expect(p.autoTdd).toBe(false)
  })

  it('pheromoneDistribution 正常: {Pe:30},{Pe:10} → files/maxPe/minPe/meanPe (AC-3)', () => {
    const d = pheromoneDistribution({
      a: { Pe: 30, Pr: 0, complexity: 0 },
      b: { Pe: 10, Pr: 0, complexity: 0 },
    })
    expect(d).toEqual({ files: 2, maxPe: 30, minPe: 10, meanPe: 20 })
  })

  it('pheromoneDistribution 空 map → 全 0 (无 NaN/Infinity) (AC-3)', () => {
    expect(pheromoneDistribution({})).toEqual({ files: 0, maxPe: 0, minPe: 0, meanPe: 0 })
  })

  it('接线 (结构断言): 8 常量字面量消失 + runs 落盘 params + stats.distribution/weights (AC-1/AC-4)', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toContain('export function effectiveParams()')
    expect(src).toContain('export function pheromoneDistribution(')
    expect(src).toContain('params: effectiveParams()')
    expect(src).toContain('stats.distribution = pheromoneDistribution(loadPheromones(workdir, warn))')
    expect(src).toContain('stats.weights = loadAgentWeights(workdir, warn)')
    // 8 常量决策点字面量已从 src 消失 (complexity: 30 / setProjectNote base 除外)
    expect(src).not.toContain('node.Pe += 30')
    expect(src).not.toContain('global.Pe += 20')
    expect(src).not.toContain('node.Pe * 0.5')
    expect(src).not.toContain('node.Pr * 0.8')
    expect(src).not.toContain('node.Pr * 0.5')
  })
})

/** P1-③: 全局 agent 信誉库 (跨 workdir 派单信誉 + 跨进程写保护) */
describe('P1-③ 全局 agent 信誉库', () => {
  it('applyReputation 状态机: win → wins+1/streak=0; loss → losses+1/streak+1; 3 连败后 win 重置 streak (AC-1)', () => {
    const now = 1_700_000_000_000
    const rep = (w: number, l: number, s: number) => ({ wins: w, losses: l, streak: s, lastUpdated: now })
    expect(applyReputation(undefined, true, now)).toEqual(rep(1, 0, 0))
    expect(applyReputation(rep(2, 1, 0), true, now)).toEqual(rep(3, 1, 0))
    expect(applyReputation(rep(2, 1, 0), false, now)).toEqual(rep(2, 2, 1))
    // 3 连败后 win → streak 归零
    expect(applyReputation(rep(0, 3, 3), true, now)).toEqual(rep(1, 3, 0))
    // loss 继续累积 streak
    expect(applyReputation(rep(0, 2, 2), false, now)).toEqual(rep(0, 3, 3))
  })

  it('repFactor: 100%样本10→1.1; 50%→1.0; 样本3不注入→1.0; 全败→0.9; undefined→1.0 (AC-3)', () => {
    const now = 1_700_000_000_000
    expect(repFactor({ wins: 10, losses: 0, streak: 0, lastUpdated: now })).toBeCloseTo(1.1, 5)
    expect(repFactor({ wins: 5, losses: 5, streak: 0, lastUpdated: now })).toBeCloseTo(1.0, 5)
    expect(repFactor({ wins: 3, losses: 0, streak: 0, lastUpdated: now })).toBe(1.0)
    expect(repFactor({ wins: 0, losses: 10, streak: 10, lastUpdated: now })).toBeCloseTo(0.9, 5)
    expect(repFactor(undefined)).toBe(1.0)
  })

  it('streakPenalty: 连败3→0.85; 连败2→1.0; undefined→1.0 (AC-3)', () => {
    const now = 1_700_000_000_000
    expect(streakPenalty({ wins: 0, losses: 3, streak: 3, lastUpdated: now })).toBe(0.85)
    expect(streakPenalty({ wins: 0, losses: 2, streak: 2, lastUpdated: now })).toBe(1.0)
    expect(streakPenalty(undefined)).toBe(1.0)
  })

  it('recordReputation 落盘: 首次 win 写入, 再次 loss 读-改-写合并 (AC-2)', () => {
    expect(globalRepPath()).toBe(join(td, 'global-agent-reputation.json'))
    recordReputation('claude_code', true, () => {})
    expect(loadGlobalReputation(() => {})).toMatchObject({ claude_code: { wins: 1, losses: 0, streak: 0 } })
    recordReputation('claude_code', false, () => {})
    const after = loadGlobalReputation(() => {})
    expect(after).toMatchObject({ claude_code: { wins: 1, losses: 1, streak: 1 } })
    // lastUpdated 落盘为 epoch ms 数字 (spec 字段, 非静默丢弃)
    expect(typeof after.claude_code?.lastUpdated).toBe('number')
  })

  it('损坏全局信誉文件 → .corrupt-* 备份 + 告警 + 空重建 (C4)', () => {
    const path = globalRepPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{broken')
    const warns: string[] = []
    expect(loadGlobalReputation(m => warns.push(m))).toEqual({})
    expect(warns.some(w => w.includes('损坏'))).toBe(true)
    expect(readdirSync(dirname(path)).some(f => f.includes('.corrupt-'))).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('TAIJI_GLOBAL_REP=0 → recordReputation no-op 不写文件, loadGlobalReputation 返回 {} (AC-4)', () => {
    process.env.TAIJI_GLOBAL_REP = '0'
    const warns: string[] = []
    expect(globalRepDisabled()).toBe(true)
    expect(loadGlobalReputation(m => warns.push(m))).toEqual({})
    // 短路: recordReputation 不触碰文件 (statSync 不被调用) 且不告警
    const stat = vi.spyOn(fs, 'statSync')
    try {
      syncBuiltinESMExports()
      recordReputation('opencode', true, m => warns.push(m))
      expect(stat).not.toHaveBeenCalled()
    } finally {
      stat.mockRestore()
      syncBuiltinESMExports()
    }
    expect(warns).toEqual([])
  })

  it('乐观并发重试合并: 冲突后重试, 最终态含两次更新 (AC-2/AC-7)', () => {
    const path = globalRepPath()
    atomicWriteJson(path, {})
    const original = fs.statSync
    let statCalls = 0
    const stat = vi.spyOn(fs, 'statSync')
    try {
      stat.mockImplementation(new Proxy(original, {
        apply(target, receiver: unknown, args: unknown[]): unknown {
          statCalls++
          const result: unknown = Reflect.apply(target, receiver, args)
          // 第 2 次 statSync (attempt0 的 after 读) 模拟另一进程并发写 opencode
          if (statCalls === 2) {
            const map = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
            map.opencode = { wins: 1, losses: 0, streak: 0, lastUpdated: 1_700_000_000_000 }
            writeFileSync(path, JSON.stringify(map))
          }
          return result
        },
      }))
      syncBuiltinESMExports()
      recordReputation('claude_code', true, () => {})
    } finally {
      stat.mockRestore()
      syncBuiltinESMExports()
    }
    const final = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { wins: number; losses: number; streak: number; lastUpdated: number }>
    expect(final.opencode).toMatchObject({ wins: 1, losses: 0, streak: 0 })
    expect(final.claude_code).toMatchObject({ wins: 1, losses: 0, streak: 0 })
    // 并发注入的 opencode 保留其 lastUpdated, 未被本进程覆盖
    expect(final.opencode?.lastUpdated).toBe(1_700_000_000_000)
  })

  it('连续 3 次冲突 → warn 告警且不抛错, 文件保持原样 (AC-2/AC-8)', () => {
    const path = globalRepPath()
    atomicWriteJson(path, {})
    const original = fs.statSync
    let mtimeTick = Date.now() + 60_000
    const stat = vi.spyOn(fs, 'statSync')
    const warns: string[] = []
    try {
      stat.mockImplementation(new Proxy(original, {
        apply(target, receiver: unknown, args: unknown[]): unknown {
          const result: unknown = Reflect.apply(target, receiver, args)
          // 每次 statSync 后拨 mtime (单调递增), 制造持续冲突
          mtimeTick += 1000
          try { utimesSync(path, new Date(mtimeTick), new Date(mtimeTick)) } catch { /* 忽略 */ }
          return result
        },
      }))
      syncBuiltinESMExports()
      expect(() => { recordReputation('claude_code', true, m => warns.push(m)) }).not.toThrow()
    } finally {
      stat.mockRestore()
      syncBuiltinESMExports()
    }
    expect(warns.some(w => w.includes('冲突'))).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({})
  })

  it('auction 返回 reputation: top-1 agent 注入因子正确记录 (AC-4)', () => {
    const pm = { 'a.py': { Pe: 90, Pr: 0, complexity: 0 } }
    atomicWriteJson(globalRepPath(), {
      claude_code: { wins: 10, losses: 0, streak: 0, lastUpdated: 1_700_000_000_000 },
      opencode: { wins: 0, losses: 3, streak: 3, lastUpdated: 1_700_000_000_000 },
    })
    const r = auction(pm, td, 1, () => {})
    expect(r).toBeDefined()
    expect(r?.reputation).toBeDefined()
    expect(r?.reputation?.agent).toBe(r?.agents?.[0])
    const reps = loadGlobalReputation(() => {})
    const topAgent = r?.reputation?.agent ?? ''
    expect(r?.reputation?.repFactor).toBeCloseTo(repFactor(reps[topAgent]), 5)
    expect(r?.reputation?.streakPenalty).toBeCloseTo(streakPenalty(reps[topAgent]), 5)
  })

  it('接线 (结构断言): auction 注入 repFactor×streakPenalty + stats.reputation 落 runs + recordReputation 同信号源 (AC-4)', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toContain('* repFactor(reps[agent]) * streakPenalty(reps[agent])')
    expect(src).toContain('stats.reputation = target?.reputation')
    expect(src).toContain('buildRunsRecord({')
    expect(src).toContain('reputation: stats.reputation')
    expect(src).toContain('recordReputation(agent, t2.ok && weightDelta > 0, warn)')
  })

  it('buildRunsRecord: stats.reputation 落入 runs 记录 (行为断言, AC-4)', () => {
    const base = {
      goal: 'g', workdir: '/w', verify: 'true', sandbox: 'full', dims: undefined,
      converged: false, finalState: '', rounds: { 1: 'x' },
      review: undefined, params: effectiveParams(), evidence: undefined,
      fingerprint: undefined,
    }
    const rec = buildRunsRecord({
      ...base,
      reputation: { agent: 'opencode', repFactor: 1.1, streakPenalty: 0.85 },
    })
    expect(rec.reputation).toEqual({ agent: 'opencode', repFactor: 1.1, streakPenalty: 0.85 })
    // 无 reputation 时落 null (而非 undefined, 保证 JSON 序列化确定性)
    const none = buildRunsRecord({ ...base, reputation: undefined })
    expect(none.reputation).toBeNull()
    expect(none.fingerprint).toBeNull()
  })
})

/** P2-①: 任务指纹 (task fingerprint — 抽象经验库分桶前置, 纯确定性) */
describe('P2-① 任务指纹', () => {
  it('category 四类: 修复→fix / 添加→feature / 重构→refactor / 口语→unknown (判据1)', () => {
    expect(taskFingerprint('修复 X', td).category).toBe('fix')
    expect(taskFingerprint('添加 Y', td).category).toBe('feature')
    expect(taskFingerprint('重构 Z', td).category).toBe('refactor')
    expect(taskFingerprint('写个 hello world', td).category).toBe('unknown')
  })

  it('互斥优先级 fix>feature>refactor: 同时含修复+添加→fix (判据2)', () => {
    expect(taskFingerprint('修复 X 并添加 Y', td).category).toBe('fix')
    expect(taskFingerprint('添加 X 并重构 Y', td).category).toBe('feature')
    expect(taskFingerprint('重构 X 并优化 Y', td).category).toBe('refactor')
  })

  it('大小写不敏感: "Fix the bug in auth" → fix (判据3)', () => {
    expect(taskFingerprint('Fix the bug in auth', td).category).toBe('fix')
  })

  it('bucket 格式精确: fix:python / feature:node / unknown:none (判据4)', () => {
    const py = join(td, 'py')
    mkdirSync(py, { recursive: true })
    writeFileSync(join(py, 'pyproject.toml'), '')
    expect(taskFingerprint('修复 X', py).bucket).toBe('fix:python')

    const node = join(td, 'node')
    mkdirSync(node, { recursive: true })
    writeFileSync(join(node, 'pnpm-lock.yaml'), '')
    expect(taskFingerprint('添加 Y', node).bucket).toBe('feature:node')

    expect(taskFingerprint('写个 hello world', td).bucket).toBe('unknown:none')
  })

  it('fp 格式精确 + 重放确定性: 同 goal 两次 deep-equal (判据5)', () => {
    const a = taskFingerprint('修复 bug', td)
    const b = taskFingerprint('修复 bug', td)
    expect(a.fp).toBe('fix:none:修复 bug')
    expect(b).toEqual(a)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('长 goal 截断: 100 字 → fp 尾部 80 字符归一化 (判据6)', () => {
    const long = 'x'.repeat(100)
    expect(taskFingerprint(long, td).fp).toBe(`unknown:none:${'x'.repeat(80)}`)
  })

  it('eco 透传: pnpm-lock.yaml→node; 空目录→none (判据7)', () => {
    writeFileSync(join(td, 'pnpm-lock.yaml'), '')
    expect(taskFingerprint('修复 X', td).eco).toBe('node')
    expect(taskFingerprint('修复 X', td).bucket).toBe('fix:node')
    rmSync(join(td, 'pnpm-lock.yaml'))
    expect(taskFingerprint('修复 X', td).eco).toBe('none')
  })

  it('goal 归一化进 fp: 全角空格/全角冒号/多空白压缩', () => {
    expect(taskFingerprint('修复　bug：登录', td).fp).toBe('fix:none:修复 bug:登录')
    expect(taskFingerprint('修复   bug', td).fp).toBe('fix:none:修复 bug')
  })

  it('空 goal → unknown + fp 尾空串 (不 crash)', () => {
    const r = taskFingerprint('', td)
    expect(r.category).toBe('unknown')
    expect(r.fp).toBe('unknown:none:')
  })

  it('接线 (结构断言): stats.fingerprint + buildRunsRecord fingerprint 落盘 + 主循环调用', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toContain('const fingerprint = taskFingerprint(goal, workdir)')
    expect(src).toContain('stats.fingerprint = fingerprint')
    expect(src).toContain('fingerprint: fingerprint ?? null')
    expect(src).toContain('reputation: stats.reputation,')
  })
})

/** P2-②: 抽象经验库 A — 桶级统计经验 (跨 workdir 桶级胜率统计) */
describe('P2-② 抽象经验库', () => {
  it('expPath 默认 ~/.taiji/global-experience.json + TAIJI_EXP 覆盖路径 (AC-4)', () => {
    expect(expPath()).toBe(join(td, 'global-experience.json'))
    delete process.env.TAIJI_EXP
    try {
      expect(expPath()).toBe(join(homedir(), '.taiji', 'global-experience.json'))
    } finally {
      process.env.TAIJI_EXP = join(td, 'global-experience.json')
    }
  })

  it('桶统计 + best/worst 派生 (平局: 先达标 best, 后达标 worst) (判据1)', () => {
    const bucket = 'fix:python'
    for (let i = 0; i < 5; i++) recordExperience(bucket, 'A', true, () => {})
    for (let i = 0; i < 5; i++) recordExperience(bucket, 'B', true, () => {})
    const rec = loadExperience(() => {})[bucket]
    expect(rec?.wins).toBe(10)
    expect(rec?.losses).toBe(0)
    expect(rec?.bestAgent).toBe('A')
    expect(rec?.worstAgent).toBe('B')
    expect(typeof rec?.updated).toBe('number')
    expect(rec?.agents).toEqual({ A: { wins: 5, losses: 0 }, B: { wins: 5, losses: 0 } })
  })

  it('小样本不参与 best/worst 竞争: 样本 2 胜率高也不当 best (判据2)', () => {
    const now = 1_700_000_000_000
    let b = applyExperience(undefined, 'A', true, now)
    expect(b.bestAgent).toBe('')
    expect(b.worstAgent).toBe('')
    b = applyExperience(b, 'A', true, now)   // 样本 2, 胜率 100% 仍不当 best
    expect(b.bestAgent).toBe('')
    b = applyExperience(b, 'A', true, now)   // 样本 3 → 参与竞争
    expect(b.bestAgent).toBe('A')
  })

  it('乐观并发重试合并: 冲突后重试, 最终态含两次更新 (判据3)', () => {
    const path = expPath()
    atomicWriteJson(path, {})
    const original = fs.statSync
    let statCalls = 0
    const stat = vi.spyOn(fs, 'statSync')
    try {
      stat.mockImplementation(new Proxy(original, {
        apply(target, receiver: unknown, args: unknown[]): unknown {
          statCalls++
          const result: unknown = Reflect.apply(target, receiver, args)
          if (statCalls === 2) {
            const map = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
            map['fix:python'] = {
              wins: 1, losses: 0, bestAgent: 'B', worstAgent: 'B', updated: 1_700_000_000_000,
              agents: { B: { wins: 1, losses: 0 } },
            }
            writeFileSync(path, JSON.stringify(map))
          }
          return result
        },
      }))
      syncBuiltinESMExports()
      recordExperience('fix:python', 'A', true, () => {})
    } finally {
      stat.mockRestore()
      syncBuiltinESMExports()
    }
    const final = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { agents: Record<string, { wins: number; losses: number }> }>
    expect(final['fix:python']?.agents).toMatchObject({
      A: { wins: 1, losses: 0 },
      B: { wins: 1, losses: 0 },
    })
  })

  it('连续 3 次冲突 → warn 告警且不抛错, 文件保持原样 (判据3)', () => {
    const path = expPath()
    atomicWriteJson(path, {})
    const original = fs.statSync
    let mtimeTick = Date.now() + 60_000
    const stat = vi.spyOn(fs, 'statSync')
    const warns: string[] = []
    try {
      stat.mockImplementation(new Proxy(original, {
        apply(target, receiver: unknown, args: unknown[]): unknown {
          const result: unknown = Reflect.apply(target, receiver, args)
          mtimeTick += 1000
          try { utimesSync(path, new Date(mtimeTick), new Date(mtimeTick)) } catch { /* 忽略 */ }
          return result
        },
      }))
      syncBuiltinESMExports()
      expect(() => { recordExperience('fix:python', 'A', true, m => warns.push(m)) }).not.toThrow()
    } finally {
      stat.mockRestore()
      syncBuiltinESMExports()
    }
    expect(warns.some(w => w.includes('冲突'))).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({})
  })

  it('expFactor 数值: 100%样本10→1.05; 50%→1.0; 样本4→1.0; undefined→1.0 (判据4)', () => {
    expect(expFactor({ wins: 10, losses: 0 })).toBeCloseTo(1.05, 5)
    expect(expFactor({ wins: 5, losses: 5 })).toBeCloseTo(1.0, 5)
    expect(expFactor({ wins: 4, losses: 0 })).toBe(1.0)
    expect(expFactor(undefined)).toBe(1.0)
  })

  it('TAIJI_EXP=0 → load 返回 {} + record no-op 不触碰文件 (判据5)', () => {
    process.env.TAIJI_EXP = '0'
    const warns: string[] = []
    expect(experienceDisabled()).toBe(true)
    expect(loadExperience(m => warns.push(m))).toEqual({})
    const stat = vi.spyOn(fs, 'statSync')
    try {
      syncBuiltinESMExports()
      recordExperience('fix:python', 'A', true, m => warns.push(m))
      expect(stat).not.toHaveBeenCalled()
    } finally {
      stat.mockRestore()
      syncBuiltinESMExports()
    }
    expect(warns).toEqual([])
  })

  it('损坏经验文件 → .corrupt-* 备份 + 告警 + 空重建 (判据6)', () => {
    const path = expPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{broken')
    const warns: string[] = []
    expect(loadExperience(m => warns.push(m))).toEqual({})
    expect(warns.some(w => w.includes('损坏'))).toBe(true)
    expect(readdirSync(dirname(path)).some(f => f.includes('.corrupt-'))).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('派生一致性: 缓存 bestAgent/worstAgent 与明细不符 → 以明细派生为准 (判据7)', () => {
    const path = expPath()
    mkdirSync(dirname(path), { recursive: true })
    atomicWriteJson(path, {
      'fix:python': {
        wins: 4, losses: 2,
        bestAgent: 'X',       // 缓存与明细不符 (A 3/3=100% 才是 best)
        worstAgent: 'A',      // 缓存与明细不符 (B 1/3≈33% 才是 worst)
        updated: 1_700_000_000_000,
        agents: { A: { wins: 3, losses: 0 }, B: { wins: 1, losses: 2 } },
      },
    })
    const rec = loadExperience(() => {})['fix:python']
    expect(rec?.bestAgent).toBe('A')
    expect(rec?.worstAgent).toBe('B')
  })

  it('auction 注入: bucket 传入 → experience 返回 + expFactor 一致 (AC-2)', () => {
    atomicWriteJson(expPath(), {
      'fix:python': {
        wins: 10, losses: 3, bestAgent: 'claude_code', worstAgent: 'opencode',
        updated: 1_700_000_000_000,
        agents: {
          claude_code: { wins: 10, losses: 0 },
          opencode: { wins: 0, losses: 3 },
        },
      },
    })
    const pm = { 'a.py': { Pe: 90, Pr: 0, complexity: 0 } }
    const r = auction(pm, td, 1, () => {}, undefined, 'fix:python')
    expect(r).toBeDefined()
    expect(r?.experience?.bucket).toBe('fix:python')
    const expMap = loadExperience(() => {})
    const topAgent = r?.agents?.[0] ?? ''
    expect(r?.experience?.expFactor).toBeCloseTo(expFactor(expMap['fix:python']?.agents[topAgent]), 5)
  })

  it('接线 (结构断言): auction bucket + expFactor + stats.experience + recordExperience 同信号源 + runs 落盘', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toContain('* repFactor(reps[agent]) * streakPenalty(reps[agent]) * expFactor(expAgents?.[agent])')
    expect(src).toContain('auction(pm, workdir, gen, warn, undefined, fingerprint.bucket)')
    expect(src).toContain('stats.experience = target?.experience')
    expect(src).toContain('recordExperience(fingerprint.bucket, agent, t2.ok && weightDelta > 0, warn)')
    expect(src).toContain('experience: stats.experience,')
    expect(src).toContain('experience: experience ?? null')
  })

  it('buildRunsRecord: stats.experience 落入 runs 记录 (行为断言, AC-2)', () => {
    const base = {
      goal: 'g', workdir: '/w', verify: 'true', sandbox: 'full', dims: undefined,
      converged: false, finalState: '', rounds: { 1: 'x' },
      review: undefined, reputation: undefined, fingerprint: undefined,
      params: effectiveParams(), evidence: undefined,
    }
    const rec = buildRunsRecord({
      ...base,
      experience: { bucket: 'fix:python', expFactor: 1.05 },
    })
    expect(rec.experience).toEqual({ bucket: 'fix:python', expFactor: 1.05 })
    const none = buildRunsRecord({ ...base })
    expect(none.experience).toBeNull()
  })
})

/** P2-③: 隔离并行 B — 真 worktree 隔离 + 择优 */
describe('P2-③ 隔离并行 worktree + 择优', () => {
  /** 初始化一个含单个提交的 git 仓库 (worktreeFor 前置条件)。 */
  const initRepo = (dir: string): void => {
    execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'])
    writeFileSync(join(dir, 'a.py'), 'v1\n')
    execFileSync('git', ['-C', dir, 'add', 'a.py'])
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'init'])
  }

  it('worktreeFor: 真 git 仓库建 wt 成功 (目录+分支存在); 非 git → ok=false 不抛 (判据1)', async () => {
    initRepo(td)
    const ts = Date.now()
    const branch = `taiji/wt-${ts}`
    const wt = await worktreeFor(td, `wt-${ts}`, branch)
    expect(wt.ok).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
    const branches = execFileSync('git', ['-C', td, 'branch', '--list', branch], { encoding: 'utf-8' })
    expect(branches).toContain(branch)
    worktreeRemove(td, wt.path, branch)
    expect(existsSync(wt.path)).toBe(false)

    const nonGit = mkdtempSync(join(tmpdir(), 'taiji-nongit-'))
    try {
      const wt2 = await worktreeFor(nonGit, 'wt-nongit', 'taiji/x')
      expect(wt2.ok).toBe(false)
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  it('worktreeRemove 幂等: 删两次不抛 + 不堆积 (判据2)', async () => {
    initRepo(td)
    const ts = Date.now()
    const branch = `taiji/rm-${ts}`
    const wt = await worktreeFor(td, `rm-${ts}`, branch)
    expect(wt.ok).toBe(true)
    worktreeRemove(td, wt.path, branch)
    expect(existsSync(wt.path)).toBe(false)
    expect(() => { worktreeRemove(td, wt.path, branch) }).not.toThrow()
    expect(existsSync(wt.path)).toBe(false)
  })

  it('checkoutFromWorktree: wt 内改动回写主 workdir + 文件不存在 ok=false (判据3)', async () => {
    initRepo(td)
    const ts = Date.now()
    const branch = `taiji/co-${ts}`
    const wt = await worktreeFor(td, `co-${ts}`, branch)
    expect(wt.ok).toBe(true)
    writeFileSync(join(wt.path, 'a.py'), 'fixed\n')
    const co = await checkoutFromWorktree(td, wt.path, 'a.py')
    expect(co.ok).toBe(true)
    expect(readFileSync(join(td, 'a.py'), 'utf-8')).toBe('fixed\n')
    const missing = await checkoutFromWorktree(td, wt.path, 'nope.py')
    expect(missing.ok).toBe(false)
    worktreeRemove(td, wt.path, branch)
  })

  it('pickWinner 三 case: 双绿先完成 / 单绿 / 双红 null (判据4)', () => {
    expect(pickWinner([
      { agent: 'a', ok: true, settledMs: 100 },
      { agent: 'b', ok: true, settledMs: 50 },
    ])?.agent).toBe('b')
    expect(pickWinner([
      { agent: 'a', ok: true, settledMs: 100 },
      { agent: 'b', ok: false, settledMs: 50 },
    ])?.agent).toBe('a')
    expect(pickWinner([
      { agent: 'a', ok: false, settledMs: 100 },
      { agent: 'b', ok: false, settledMs: 50 },
    ])).toBeNull()
    expect(pickWinner([])).toBeNull()
  })

  it('parallelFallbackReason 降级五 case + 全满足 undefined (判据5)', () => {
    expect(parallelFallbackReason(false, 2, 'a.py', 'tracked')).toBe('disabled')
    expect(parallelFallbackReason(true, 1, 'a.py', 'tracked')).toBe('single-agent')
    expect(parallelFallbackReason(true, 2, '__project__', 'tracked')).toBe('project-level')
    expect(parallelFallbackReason(true, 2, 'a.py', 'non-git')).toBe('non-git')
    expect(parallelFallbackReason(true, 2, 'a.py', 'untracked')).toBe('untracked')
    expect(parallelFallbackReason(true, 2, 'a.py', 'tracked')).toBeUndefined()
  })

  it('effectiveParams().parallel 默认 1 + env TAIJI_PARALLEL=0 → 0 (判据7)', () => {
    expect(effectiveParams().parallel).toBe('1')
    process.env.TAIJI_PARALLEL = '0'
    expect(effectiveParams().parallel).toBe('0')
  })

  it('recordParallelSignals: 胜出记 win, 落败记 loss (mock 计数, 判据6)', () => {
    const updateAgentWeight = vi.fn()
    const recordReputation = vi.fn()
    const recordExperience = vi.fn()
    const warn = vi.fn()
    const r = recordParallelSignals({
      winner: 'opencode',
      losers: ['claude_code'],
      bucket: 'fix:python',
      workdir: td,
      changedFiles: ['a.py'],
      failedFiles: ['a.py'],
      rOk: true,
      t2Ok: true,
      warn,
      updateAgentWeight,
      recordReputation,
      recordExperience,
    })
    expect(r.weightDelta).toBe(1)
    expect(r.hasChange).toBe(true)
    expect(updateAgentWeight).toHaveBeenCalledWith(td, 'opencode', 1, warn)
    expect(recordReputation).toHaveBeenCalledWith('opencode', true, warn)
    expect(recordReputation).toHaveBeenCalledWith('claude_code', false, warn)
    expect(recordExperience).toHaveBeenCalledWith('fix:python', 'opencode', true, warn)
    expect(recordExperience).toHaveBeenCalledWith('fix:python', 'claude_code', false, warn)
  })

  it('parallelAttempt: delegate/runVerify 收到 wt.path (workdir 参数, 判据6)', async () => {
    const delegate = vi.fn().mockResolvedValue({ ok: true, out: '' })
    const runVerify = vi.fn().mockResolvedValue({ ok: true, out: '', code: 0 })
    const results = await parallelAttempt({
      agents: [
        { agent: 'claude_code', provider: 'claude-code', path: '/tmp/taiji-wt-1' },
        { agent: 'opencode', provider: 'opencode', path: '/tmp/taiji-wt-2' },
      ],
      delegate,
      runVerify,
    })
    expect(results).toHaveLength(2)
    expect(delegate).toHaveBeenCalledTimes(2)
    expect(delegate).toHaveBeenCalledWith('claude-code', '太极claude_code修复', '/tmp/taiji-wt-1')
    expect(delegate).toHaveBeenCalledWith('opencode', '太极opencode修复', '/tmp/taiji-wt-2')
    expect(runVerify).toHaveBeenCalledTimes(2)
    expect(runVerify).toHaveBeenCalledWith('/tmp/taiji-wt-1')
    expect(runVerify).toHaveBeenCalledWith('/tmp/taiji-wt-2')
    expect(results.every(x => x.ok)).toBe(true)
  })

  it('主循环接线 (结构断言): 并行分支 + stats.parallel + runs 落盘 (判据7)', () => {
    const src = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf-8')
    expect(src).toContain('export async function worktreeFor(')
    expect(src).toContain('export function worktreeRemove(')
    expect(src).toContain('export async function checkoutFromWorktree(')
    expect(src).toContain('export function pickWinner(')
    expect(src).toContain('export function parallelFallbackReason(')
    expect(src).toContain('process.env.TAIJI_PARALLEL')
    expect(src).toContain('Promise.allSettled(')
    expect(src).toContain('pickWinner(results)')
    expect(src).toContain('checkoutFromWorktree(workdir')
    expect(src).toContain('worktreeFor(workdir')
    expect(src).toContain('worktreeRemove(workdir')
    expect(src).toContain('stats.parallel =')
    expect(src).toContain('parallel: stats.parallel')
    expect(src).toContain("parallel: process.env.TAIJI_PARALLEL === '0' ? '0' : '1'")
    expect(src).toContain('target.agents.slice(parallelStart)')
  })
})
