'use strict';
// Pemakaian: npm run reset-password -- <username> <password-baru>
const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('Pemakaian: npm run reset-password -- <username> <password-baru (min 8 karakter)>');
  process.exit(1);
}
const { db, hashPassword } = require('../server.js');
const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!u) {
  console.error(`Pengguna "${username}" tidak ditemukan.`);
  process.exit(1);
}
db.prepare('UPDATE users SET pass_hash = ?, active = 1 WHERE id = ?').run(hashPassword(password), u.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
console.log(`Password untuk "${username}" berhasil diubah.`);
process.exit(0);
