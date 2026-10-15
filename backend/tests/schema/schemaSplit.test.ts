import fs from 'node:fs';
import path from 'node:path';
import { buildSchemaSql, checkSchemaSql } from '../../db/build-schema';

describe('Modular Schema Split and Build Pipeline', () => {
  const schemaDir = path.join(__dirname, '../../db/schema');
  const domainFiles = () => fs.readdirSync(schemaDir).filter((f) => f.endsWith('.sql'));

  it('ensures no domain file contains em-dashes', () => {
    const files = domainFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const filePath = path.join(schemaDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).not.toContain('\u2014');
    }
  });

  it('validates that backend/db/schema.sql is in sync with backend/db/schema/*.sql', () => {
    expect(checkSchemaSql()).toBe(true);
  });

  /**
   * Rule 2 of the layout the redesign proposal sets out: every table is declared
   * once, and a forward reference goes in 95_deferred_fks.sql. A second
   * `create table if not exists` for the same name is silently a no-op, so the
   * later declaration's columns never exist and nothing says so. Migration 0204
   * exists because `matters` was declared twice.
   *
   * This replaces a hand-maintained "exactly N tables" count, which had to be
   * edited on every merge and could not fail for any reason worth catching.
   */
  it('declares every table exactly once across the domain files', () => {
    const declarations = [...buildSchemaSql().matchAll(/create table if not exists ([a-z0-9_]+)/gi)]
      .map((m) => m[1].toLowerCase());
    const seen = new Map<string, number>();
    for (const name of declarations) seen.set(name, (seen.get(name) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name);
    expect(duplicated).toEqual([]);
    expect(declarations.length).toBe(seen.size);
  });
});
