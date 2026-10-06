// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), '.github/workflows/deploy-pages.yml'), 'utf8')
const condition = /    if: >-\r?\n([\s\S]*?)\r?\n    runs-on:/.exec(source)?.[1]
if (!condition) throw new Error('找不到 Pages 构建的真实来源门禁')

interface RunFixture {
  event?: string
  conclusion?: string
  head_branch?: string
  head_repository?: { full_name: string }
}

function allows(eventName: string, ref: string, run?: RunFixture): boolean {
  // 读取项目自己的条件，使用相同的逻辑运算与属性访问；避免另写一份“正确门禁”掩盖 YAML 回归。
  return Boolean(runInNewContext(condition ?? '', {
    github: { event_name: eventName, ref, repository: 'LHC728/yike', event: { workflow_run: run } },
  }, { timeout: 100 }))
}

const valid: RunFixture = { event: 'push', conclusion: 'success', head_branch: 'main', head_repository: { full_name: 'LHC728/yike' } }

describe('Pages 发布的实际来源门禁', () => {
  it('本仓库 main push 的成功 CI 可以发布', () => {
    expect(allows('workflow_run', 'refs/heads/main', valid)).toBe(true)
  })
  it('fork 的 main 分支 PR 即便 CI 成功也不能发布', () => {
    expect(allows('workflow_run', 'refs/heads/main', { ...valid, event: 'pull_request', head_repository: { full_name: 'attacker/yike' } })).toBe(false)
  })
  it('本仓库尚未合并的 PR 也不能发布', () => {
    expect(allows('workflow_run', 'refs/heads/main', { ...valid, event: 'pull_request' })).toBe(false)
  })
  it('另一仓库的 push 不因分支同名而取得发布权', () => {
    expect(allows('workflow_run', 'refs/heads/main', { ...valid, head_repository: { full_name: 'attacker/yike' } })).toBe(false)
  })
  it('失败 CI 和非 main 的 push 不能发布', () => {
    expect(allows('workflow_run', 'refs/heads/main', { ...valid, conclusion: 'failure' })).toBe(false)
    expect(allows('workflow_run', 'refs/heads/main', { ...valid, head_branch: 'feature' })).toBe(false)
  })
  it('手动运行只允许 main，不允许 feature 或 tag', () => {
    expect(allows('workflow_dispatch', 'refs/heads/main')).toBe(true)
    expect(allows('workflow_dispatch', 'refs/heads/feature')).toBe(false)
    expect(allows('workflow_dispatch', 'refs/tags/v1.0.0')).toBe(false)
  })
})
