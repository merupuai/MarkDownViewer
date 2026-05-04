#!/usr/bin/env node

// CoBolt TDD Gate — CLI wrapper around the source hook implementation.
//
// Keeps the hook invocable from tools/ so build step documentation can resolve
// the same path contract that the runtime hooks use.

const gate = require('../source/hooks/cobolt-tdd-gate');

module.exports = gate;

if (require.main === module) {
  let data = '';
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const input = data ? JSON.parse(data) : null;
      process.stdout.write(JSON.stringify(gate.run(input)));
    } catch (error) {
      process.stdout.write(
        JSON.stringify({ action: 'block', message: `TDD GATE: Failed to parse input — ${error.message}` }),
      );
    }
  });
}
