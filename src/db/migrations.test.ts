import { describe, expect, it } from 'vitest'
import { pendingMigrations, sortMigrationNames } from './migrations'

describe('sortMigrationNames', () => {
  it('ordena por número, no alfabéticamente por el nombre suelto', () => {
    expect(
      sortMigrationNames(['0010_zeta.sql', '0002_alpha.sql', '0001_beta.sql']),
    ).toEqual(['0001_beta.sql', '0002_alpha.sql', '0010_zeta.sql'])
  })

  it('rechaza nombres sin prefijo numérico', () => {
    expect(() => sortMigrationNames(['init.sql'])).toThrow(/inválido/)
  })

  it('rechaza nombres con mayúsculas o espacios', () => {
    expect(() => sortMigrationNames(['0001_Init.sql'])).toThrow(/inválido/)
    expect(() => sortMigrationNames(['0001 init.sql'])).toThrow(/inválido/)
  })
})

describe('pendingMigrations', () => {
  it('devuelve todas cuando la base está vacía', () => {
    expect(pendingMigrations(['0001_a.sql', '0002_b.sql'], [])).toEqual([
      '0001_a.sql',
      '0002_b.sql',
    ])
  })

  it('devuelve vacío cuando ya está todo aplicado', () => {
    expect(pendingMigrations(['0001_a.sql'], ['0001_a.sql'])).toEqual([])
  })

  it('devuelve solo las nuevas, en orden', () => {
    expect(
      pendingMigrations(
        ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
        ['0001_a.sql'],
      ),
    ).toEqual(['0002_b.sql', '0003_c.sql'])
  })

  it('falla si la base tiene una migración que no está en disco', () => {
    expect(() =>
      pendingMigrations(['0001_a.sql'], ['0001_a.sql', '0002_fantasma.sql']),
    ).toThrow(/no están en disco/)
  })

  it('falla si aparece una migración anterior a la última aplicada', () => {
    expect(() =>
      pendingMigrations(['0001_a.sql', '0002_b.sql'], ['0002_b.sql']),
    ).toThrow(/fuera de orden/)
  })
})
