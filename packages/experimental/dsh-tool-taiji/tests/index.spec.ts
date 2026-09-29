import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  failedFilesFromOutput,
  getChangedFiles,
  hasRelevantChange,
  isFailClosed,
  resolveConvergence,
  resolvePrNote,
  setProjectNote,
} from '../src/index.js'

let td: string
beforeEach(() => {
  td = mkdtempSync(join(tmpdir(), 'taiji-test-'))
})
afterEach(() => {
  rmSync(td, { recursive: true, force: true })
  delete process.env.TAIJI_VERIFY_SHELL_OK
  delete process.env.TAIJI_RANDOM_BID
  delete process.env.TAIJI_FAILED_FILE_RE
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
      expect(block).toContain('resolveConvergence(g, piFail, gen, review.danger)')
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
