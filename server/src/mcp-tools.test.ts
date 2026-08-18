import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextAvailableAlias } from './mcp-tools.js'

test('slugifies a plain name with no collisions', () => {
  assert.equal(nextAvailableAlias('Brave Search', []), 'brave-search')
})

test('strips characters outside a-z0-9- and collapses runs', () => {
  assert.equal(nextAvailableAlias('  Weird!! Name_2  ', []), 'weird-name-2')
})

test('falls back to "tool" when the name has no alnum characters', () => {
  assert.equal(nextAvailableAlias('***', []), 'tool')
})

test('appends -2 when the base slug is taken', () => {
  assert.equal(nextAvailableAlias('Brave Search', ['brave-search']), 'brave-search-2')
})

test('skips every taken suffix to find the first free one', () => {
  assert.equal(
    nextAvailableAlias('Brave Search', ['brave-search', 'brave-search-2', 'brave-search-3']),
    'brave-search-4',
  )
})

test('comparison against existing aliases is case-insensitive', () => {
  assert.equal(nextAvailableAlias('Brave Search', ['BRAVE-SEARCH']), 'brave-search-2')
})
