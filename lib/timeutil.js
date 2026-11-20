'use strict';
// Utilitas zona waktu tanpa dependensi (berbasis Intl).

function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsInZone(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const x of dtf.formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}

// selisih (zona - UTC) dalam ms pada saat ms
function tzOffsetMs(ms, tz) {
  const p = partsInZone(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// "2026-11-16" + "08:30" di zona tz -> epoch ms (UTC)
function zonedToUtcMs(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let off = tzOffsetMs(guess, tz);
  const res = guess - off;
  off = tzOffsetMs(res, tz);
  return guess - off;
}

function todayInZone(tz, ms = Date.now()) {
  const p = partsInZone(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

function formatTime(ms, tz) {
  const p = partsInZone(ms, tz);
  return `${p.hour}:${p.minute}:${p.second}`;
}

function formatDateTime(ms, tz) {
  const p = partsInZone(ms, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

module.exports = { validTz, zonedToUtcMs, todayInZone, formatTime, formatDateTime };
