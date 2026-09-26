/**
 * SQLite 持久化（node:sqlite，同步 API）。
 *
 * 三张表：
 *  - rooms(code PRIMARY KEY, state_json, expires_at, revision)
 *  - receipts(room_code, game_number, player_id, request_id, result_json, created_at) 唯一回执
 *  - completed_games(room_code, game_number, state_json, finished_at) 已完成对局归档
 *
 * 启用 WAL、外键与 busy_timeout。状态变更与 roll 回执由 room-service 放在同一事务提交。
 * 数据库文件属于运行数据，不得入库（见 .gitignore）。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RoomRow {
  code: string;
  stateJson: string;
  expiresAt: number;
  revision: number;
}

export interface ReceiptRow {
  resultJson: string;
}

interface Statement {
  run: (...params: Array<string | number | null>) => unknown;
  get: (...params: Array<string | number | null>) => unknown;
  all: (...params: Array<string | number | null>) => unknown[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  code        TEXT PRIMARY KEY,
  state_json  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rooms_expires_at ON rooms (expires_at);

CREATE TABLE IF NOT EXISTS receipts (
  room_code    TEXT NOT NULL,
  game_number  INTEGER NOT NULL,
  player_id    TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  result_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (room_code, game_number, player_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_receipts_room ON receipts (room_code);

CREATE TABLE IF NOT EXISTS completed_games (
  room_code    TEXT NOT NULL,
  game_number  INTEGER NOT NULL,
  state_json   TEXT NOT NULL,
  finished_at  INTEGER NOT NULL,
  PRIMARY KEY (room_code, game_number)
);
CREATE INDEX IF NOT EXISTS idx_completed_games_room ON completed_games (room_code);

-- 过期墓碑：房间清理后仅保留极轻量的标记，让原房码在一段保留期内仍返回 410 过期提示，
-- 而不是变成“房间不存在”。保留期到期后由 tick 一并清理。
CREATE TABLE IF NOT EXISTS expired_rooms (
  code        TEXT PRIMARY KEY,
  expired_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expired_rooms_expired_at ON expired_rooms (expired_at);
`;

export class AppDatabase {
  readonly file: string;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, Statement>();
  private inTransaction = false;

  constructor(file: string) {
    this.file = file;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  private stmt(sql: string): Statement {
    let cached = this.statements.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql) as unknown as Statement;
      this.statements.set(sql, cached);
    }
    return cached;
  }

  /**
   * 同步事务。单 Node 进程内所有状态变更走这里，事务中不做任何 await。
   * 嵌套调用时复用外层事务，避免 SQLite 不支持嵌套 BEGIN。
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 连接已失效时忽略回滚失败，向上抛出原始错误
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  ping(): boolean {
    const row = this.stmt('SELECT 1 AS ok').get() as { ok?: number } | undefined;
    return row?.ok === 1;
  }

  getRoom(code: string): RoomRow | null {
    const row = this.stmt('SELECT state_json, expires_at, revision FROM rooms WHERE code = ?').get(code) as
      | { state_json: string; expires_at: number; revision: number }
      | undefined;
    if (!row) return null;
    return { code, stateJson: row.state_json, expiresAt: row.expires_at, revision: row.revision };
  }

  listRoomCodes(now: number): string[] {
    const rows = this.stmt('SELECT code FROM rooms WHERE expires_at > ? ORDER BY code').all(now) as Array<{ code: string }>;
    return rows.map((row) => row.code);
  }

  listExpiredCodes(now: number): string[] {
    const rows = this.stmt('SELECT code FROM rooms WHERE expires_at <= ? ORDER BY code').all(now) as Array<{ code: string }>;
    return rows.map((row) => row.code);
  }

  saveRoom(row: RoomRow): void {
    this.stmt(
      `INSERT INTO rooms (code, state_json, expires_at, revision) VALUES (?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET state_json = excluded.state_json,
                                       expires_at = excluded.expires_at,
                                       revision = excluded.revision`,
    ).run(row.code, row.stateJson, row.expiresAt, row.revision);
  }

  /** 删除房间及其回执、归档（过期清理与全员离开后复用）。 */
  deleteRoom(code: string): void {
    this.stmt('DELETE FROM receipts WHERE room_code = ?').run(code);
    this.stmt('DELETE FROM completed_games WHERE room_code = ?').run(code);
    this.stmt('DELETE FROM rooms WHERE code = ?').run(code);
  }

  /** 记录过期墓碑（不含任何房间内容）。 */
  markExpired(code: string, now: number): void {
    this.stmt(
      `INSERT INTO expired_rooms (code, expired_at) VALUES (?, ?)
       ON CONFLICT(code) DO UPDATE SET expired_at = excluded.expired_at`,
    ).run(code, now);
  }

  isExpiredCode(code: string): boolean {
    const row = this.stmt('SELECT 1 AS hit FROM expired_rooms WHERE code = ?').get(code) as { hit?: number } | undefined;
    return row?.hit === 1;
  }

  /** 清理超过保留期的墓碑，避免无限增长。 */
  purgeExpiredTombstones(before: number): number {
    const rows = this.stmt('SELECT code FROM expired_rooms WHERE expired_at <= ?').all(before) as Array<{ code: string }>;
    for (const row of rows) this.stmt('DELETE FROM expired_rooms WHERE code = ?').run(row.code);
    return rows.length;
  }

  saveReceipt(row: {
    roomCode: string;
    gameNumber: number;
    playerId: string;
    requestId: string;
    resultJson: string;
    createdAt: number;
  }): void {
    this.stmt(
      `INSERT INTO receipts (room_code, game_number, player_id, request_id, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_code, game_number, player_id, request_id) DO NOTHING`,
    ).run(row.roomCode, row.gameNumber, row.playerId, row.requestId, row.resultJson, row.createdAt);
  }

  findReceipt(roomCode: string, gameNumber: number, playerId: string, requestId: string): ReceiptRow | null {
    const row = this.stmt(
      'SELECT result_json FROM receipts WHERE room_code = ? AND game_number = ? AND player_id = ? AND request_id = ?',
    ).get(roomCode, gameNumber, playerId, requestId) as { result_json: string } | undefined;
    return row ? { resultJson: row.result_json } : null;
  }

  saveCompletedGame(roomCode: string, gameNumber: number, stateJson: string, finishedAt: number): void {
    this.stmt(
      `INSERT INTO completed_games (room_code, game_number, state_json, finished_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(room_code, game_number) DO UPDATE SET state_json = excluded.state_json,
                                                        finished_at = excluded.finished_at`,
    ).run(roomCode, gameNumber, stateJson, finishedAt);
  }

  getCompletedGame(roomCode: string, gameNumber: number): { stateJson: string; finishedAt: number } | null {
    const row = this.stmt('SELECT state_json, finished_at FROM completed_games WHERE room_code = ? AND game_number = ?').get(
      roomCode,
      gameNumber,
    ) as { state_json: string; finished_at: number } | undefined;
    return row ? { stateJson: row.state_json, finishedAt: row.finished_at } : null;
  }

  /** 供测试与健康检查使用的行数统计。 */
  counts(): { rooms: number; receipts: number; completedGames: number; expiredRooms: number } {
    const one = (sql: string): number => {
      const row = this.stmt(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    return {
      rooms: one('SELECT COUNT(*) AS n FROM rooms'),
      receipts: one('SELECT COUNT(*) AS n FROM receipts'),
      completedGames: one('SELECT COUNT(*) AS n FROM completed_games'),
      expiredRooms: one('SELECT COUNT(*) AS n FROM expired_rooms'),
    };
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
