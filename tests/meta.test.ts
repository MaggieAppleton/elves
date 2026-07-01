import { expect, test } from 'vitest'
import { ELVES } from '../src/meta'

test('toolchain runs and resolves src imports', () => {
  expect(ELVES).toBe('elves')
})
