#!/usr/bin/env node

// CoBolt Lesson Prefix — CLI wrapper for lib/cobolt-lesson-prefix.js
//
// Usage:
//   node tools/cobolt-lesson-prefix.js read         # print pending lessons text (empty if none)
//   node tools/cobolt-lesson-prefix.js consume      # clear pending lesson side-file
//
// Exists so skills never do `require('.../lib/cobolt-lesson-prefix')` (CLAUDE.md invariant #14).

const { readPendingLessons, consume } = require('../lib/cobolt-lesson-prefix');

const cmd = process.argv[2];

try {
  switch (cmd) {
    case 'read': {
      const lessons = readPendingLessons(process.cwd());
      if (lessons) process.stdout.write(lessons);
      break;
    }
    case 'consume':
      consume(process.cwd());
      break;
    default:
      console.error('usage: cobolt-lesson-prefix.js <read|consume>');
      process.exit(2);
  }
} catch (err) {
  console.error(`cobolt-lesson-prefix: ${err.message}`);
  process.exit(1);
}
