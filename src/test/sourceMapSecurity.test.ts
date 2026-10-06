// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SourceMapConsumer, SourceMapGenerator, type MappingItem } from 'source-map-js'

function basicMap() {
  const generator = new SourceMapGenerator({ file: 'bundle.js' })
  generator.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: 'original.ts' })
  generator.setSourceContent('original.ts', 'const value = 1;\n')
  return generator.toJSON()
}

function sectionMap(line: number, inner = basicMap()) {
  return { ...basicMap(), sections: [{ offset: { line, column: 0 }, map: inner }] }
}

describe('source-map-js 安全输入契约', () => {
  it('在构造时拒绝超限单层与累计嵌套偏移，不进入放大路径', () => {
    // CVE-2026-93749：旧版接受小 map 的巨大偏移，后续生成器会按行数放大；只测立即拒绝。
    for (const map of [sectionMap(10_000_001), sectionMap(6_000_000, sectionMap(6_000_000))]) {
      expect(() => new SourceMapConsumer(map)).toThrow(/Section offset line must not exceed/)
    }
  })

  it('保留合法普通与小偏移嵌套 map 的映射和源文本', () => {
    const flat = new SourceMapConsumer(basicMap())
    expect(flat.originalPositionFor({ line: 1, column: 0 })).toEqual({ source: 'original.ts', line: 1, column: 0, name: null })
    const indexed = new SourceMapConsumer(sectionMap(2, sectionMap(1)))
    const mappings: MappingItem[] = []
    indexed.eachMapping((mapping) => mappings.push(mapping))
    expect(mappings).toEqual([{ source: 'original.ts', generatedLine: 4, generatedColumn: 0, originalLine: 1, originalColumn: 0, name: null }])
    expect(indexed.sourceContentFor('original.ts')).toBe('const value = 1;\n')
    expect(indexed.sources).toEqual(['original.ts'])
    expect(indexed.hasContentsOfAllSources()).toBe(true)
  })
})
