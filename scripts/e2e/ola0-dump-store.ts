#!/usr/bin/env bun
// Volcado TSV de la base local de fab (fabrica.db) para las pruebas E2E de la ola 0.
// Solo lectura: no muta nada. Con este volcado los scripts invariantes aseveran sobre
// actividades, cambios y eventos sin depender del texto de la CLI.
// Las columnas de tiempo salen en ms epoch para poder filtrar/pensar en awk sin parsear ISO.
//
//   bun ola0-dump-store.ts <FABRICA_HOME> [activities|events|changes|signals]

import { Database } from 'bun:sqlite';

const home = process.argv[2];
const what = process.argv[3] ?? 'activities';
if (!home) {
  console.error('uso: ola0-dump-store.ts <FABRICA_HOME> [activities|events|changes|signals]');
  process.exit(1);
}

const db = new Database(`${home}/fabrica.db`, { readonly: true });
const ms = (iso: unknown): unknown => (iso === null || iso === undefined ? '' : Date.parse(String(iso)) || '');

function print(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  console.log(Object.keys(rows[0]).join('\t'));
  for (const r of rows) {
    console.log(
      Object.values(r)
        .map((v) => (v === null || v === undefined ? '' : String(v).replace(/[\t\n\r]+/g, ' ')))
        .join('\t')
    );
  }
}

switch (what) {
  case 'activities': {
    const rows = (
      db.query(
        `SELECT id, workstream_id, change_id, kind, validator, status, review_status, worker_id,
                retry_count, error, started_at, completed_at
         FROM activities ORDER BY created_at, rowid`
      ).all() as Record<string, unknown>[]
    ).map((r) => {
      r.started_ms = ms(r.started_at);
      r.completed_ms = ms(r.completed_at);
      delete r.started_at;
      delete r.completed_at;
      return r;
    });
    print(rows);
    break;
  }
  case 'events': {
    const rows = (
      db.query(
        `SELECT id, workstream_id, change_id, activity_id, severity, message, created_at
         FROM events ORDER BY id`
      ).all() as Record<string, unknown>[]
    ).map((r) => {
      r.created_ms = ms(r.created_at);
      delete r.created_at;
      return r;
    });
    print(rows);
    break;
  }
  case 'changes': {
    const rows = (
      db.query(
        `SELECT id, workstream_id, title, status, branch, created_at, updated_at
         FROM changes ORDER BY created_at, rowid`
      ).all() as Record<string, unknown>[]
    ).map((r) => {
      r.created_ms = ms(r.created_at);
      r.updated_ms = ms(r.updated_at);
      delete r.created_at;
      delete r.updated_at;
      return r;
    });
    print(rows);
    break;
  }
  case 'signals': {
    const rows = (
      db.query(
        `SELECT id, workstream_id, title, status, change_id, created_at
         FROM signals ORDER BY created_at, rowid`
      ).all() as Record<string, unknown>[]
    ).map((r) => {
      r.created_ms = ms(r.created_at);
      delete r.created_at;
      return r;
    });
    print(rows);
    break;
  }
  default:
    console.error(`categoría desconocida: ${what}`);
    process.exit(1);
}
