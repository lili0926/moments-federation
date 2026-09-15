#!/usr/bin/env node
/**
 * 备份 moments.db。
 *
 *   node scripts/backup.js [备份目录]
 *
 * 默认备到 ./data/backups/，保留最近 14 份。
 *
 * **不要用 cp 备份正在跑的 SQLite。** 服务还在写的时候直接复制文件，
 * 可能抄到一个写到一半的页，恢复时才发现坏了 —— 而那通常是你最需要它的时候。
 * 这里用的是 SQLite 自己的在线备份 API（better-sqlite3 的 db.backup()），
 * 它会拿到一致的快照，服务照跑不误。
 *
 * 也没用 sqlite3 命令行：那是个额外依赖，很多机器上压根没装
 * （这个项目当初那台就没有）。
 *
 * 挂进 crontab 每天一次：
 *   0 4 * * * cd /path/to/backend && /usr/bin/node scripts/backup.js >> data/backup.log 2>&1
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const KEEP = parseInt(process.env.BACKUP_KEEP || '14', 10);

function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const dbPath = path.resolve(
    __dirname, '..',
    process.env.DB_PATH || './data/moments.db'
  );
  if (!fs.existsSync(dbPath)) {
    console.error(`找不到数据库：${dbPath}`);
    process.exit(1);
  }

  const outDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(outDir, `moments-${stamp}.db`);

  const db = new Database(dbPath, { readonly: true });
  db.backup(dest)
    .then(() => {
      db.close();
      const size = fs.statSync(dest).size;
      console.log(`${new Date().toISOString()}  备份完成 ${dest} (${(size / 1024).toFixed(1)} KB)`);
      prune(outDir);
    })
    .catch((e) => {
      db.close();
      console.error('备份失败:', e.message);
      process.exit(1);
    });
}

function prune(dir) {
  if (!KEEP) return;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^moments-.*\.db$/.test(f))
    .sort()          // 文件名里是 ISO 时间戳，字典序就是时间序
    .reverse();
  for (const f of files.slice(KEEP)) {
    fs.unlinkSync(path.join(dir, f));
    console.log(`  删掉旧备份 ${f}`);
  }
}

main();
