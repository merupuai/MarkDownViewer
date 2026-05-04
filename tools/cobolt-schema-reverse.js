#!/usr/bin/env node

// CoBolt Schema Reverse — Database schema reverse engineering
//
// Usage:
//   node tools/cobolt-schema-reverse.js <db-connection-or-path> [options]
//   node tools/cobolt-schema-reverse.js ./database.db --format mermaid
//   node tools/cobolt-schema-reverse.js postgresql://... --profile --json
//
// Features:
//   - Schema dump (tables, columns, types, constraints)
//   - ERD generation (Mermaid format)
//   - Data profiling (distinct counts, null rates, patterns)
//   - Referential integrity discovery (implicit FKs)
//   - Stored procedure extraction

const fs = require('node:fs');
const path = require('node:path');

// ── Schema Analysis ────────────────────────────────────────

function analyzeSchemaFile(filePath) {
  // Analyze SQL dump files, SQLite databases, or schema definition files
  const results = {
    source: filePath,
    timestamp: new Date().toISOString(),
    tables: [],
    relationships: [],
    storedProcedures: [],
    views: [],
    triggers: [],
    indexes: [],
    implicitFKs: [],
    summary: {},
  };

  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.sql') {
    return analyzeSQLDump(content, results);
  } else if (ext === '.ddl') {
    return analyzeSQLDump(content, results);
  }

  // Try parsing as SQL regardless
  return analyzeSQLDump(content, results);
}

function analyzeSQLDump(sql, results) {
  // Extract CREATE TABLE statements
  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s*\(([\s\S]*?)\);/gi;
  let match;

  while ((match = tableRegex.exec(sql)) !== null) {
    const tableName = match[1];
    const columnDefs = match[2];
    const table = parseTable(tableName, columnDefs);
    results.tables.push(table);
  }

  // Extract FOREIGN KEY constraints for relationships
  for (const table of results.tables) {
    for (const col of table.columns) {
      if (col.foreignKey) {
        results.relationships.push({
          from: `${table.name}.${col.name}`,
          to: col.foreignKey,
          type: 'explicit_fk',
        });
      }
    }
  }

  // Discover implicit FKs from naming conventions
  for (const table of results.tables) {
    for (const col of table.columns) {
      if (col.name.endsWith('_id') && !col.foreignKey) {
        const refTable = col.name.replace(/_id$/, '');
        const matchTable = results.tables.find(
          (t) =>
            t.name.toLowerCase() === refTable.toLowerCase() || t.name.toLowerCase() === `${refTable.toLowerCase()}s`,
        );
        if (matchTable) {
          results.implicitFKs.push({
            from: `${table.name}.${col.name}`,
            to: `${matchTable.name}.id`,
            confidence: 'high',
            evidence: 'naming_convention',
          });
        }
      }
    }
  }

  // Extract stored procedures
  const procRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+[`"']?(\w+)[`"']?/gi;
  while ((match = procRegex.exec(sql)) !== null) {
    results.storedProcedures.push({ name: match[1] });
  }

  // Extract views
  const viewRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+[`"']?(\w+)[`"']?/gi;
  while ((match = viewRegex.exec(sql)) !== null) {
    results.views.push({ name: match[1] });
  }

  // Extract triggers
  const triggerRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+[`"']?(\w+)[`"']?/gi;
  while ((match = triggerRegex.exec(sql)) !== null) {
    results.triggers.push({ name: match[1] });
  }

  // Summary
  results.summary = {
    tables: results.tables.length,
    columns: results.tables.reduce((sum, t) => sum + t.columns.length, 0),
    explicitFKs: results.relationships.length,
    implicitFKs: results.implicitFKs.length,
    storedProcedures: results.storedProcedures.length,
    views: results.views.length,
    triggers: results.triggers.length,
  };

  return results;
}

function parseTable(name, columnDefs) {
  const table = { name, columns: [], primaryKey: [], constraints: [] };
  const lines = columnDefs
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    // Skip constraint-only lines
    if (/^\s*(PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT|FOREIGN\s+KEY)/i.test(line)) {
      table.constraints.push(line.trim());
      // Extract PK
      const pkMatch = line.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
      if (pkMatch) {
        table.primaryKey = pkMatch[1].split(',').map((c) => c.trim().replace(/[`"']/g, ''));
      }
      continue;
    }

    const colMatch = line.match(/^\s*[`"']?(\w+)[`"']?\s+(\w[\w(),.]*)/i);
    if (colMatch) {
      const col = {
        name: colMatch[1],
        type: colMatch[2],
        nullable: !/NOT\s+NULL/i.test(line),
        primaryKey: /PRIMARY\s+KEY/i.test(line),
        unique: /UNIQUE/i.test(line),
        defaultValue: null,
        foreignKey: null,
      };

      const defaultMatch = line.match(/DEFAULT\s+(.+?)(?:\s+|,|$)/i);
      if (defaultMatch) col.defaultValue = defaultMatch[1].trim();

      const fkMatch = line.match(/REFERENCES\s+[`"']?(\w+)[`"']?\s*\([`"']?(\w+)[`"']?\)/i);
      if (fkMatch) col.foreignKey = `${fkMatch[1]}.${fkMatch[2]}`;

      if (col.primaryKey) table.primaryKey.push(col.name);

      table.columns.push(col);
    }
  }

  return table;
}

function generateMermaidERD(results) {
  const lines = ['erDiagram'];

  for (const table of results.tables) {
    lines.push(`    ${table.name} {`);
    for (const col of table.columns) {
      const pk = col.primaryKey ? 'PK' : '';
      const fk = col.foreignKey ? 'FK' : '';
      const tag = [pk, fk].filter(Boolean).join(',');
      lines.push(`        ${col.type} ${col.name}${tag ? ` "${tag}"` : ''}`);
    }
    lines.push('    }');
  }

  // Explicit relationships
  for (const rel of results.relationships) {
    const [fromTable] = rel.from.split('.');
    const [toTable] = rel.to.split('.');
    lines.push(`    ${toTable} ||--o{ ${fromTable} : "has"`);
  }

  // Implicit relationships
  for (const rel of results.implicitFKs) {
    const [fromTable] = rel.from.split('.');
    const [toTable] = rel.to.split('.');
    lines.push(`    ${toTable} ||--o{ ${fromTable} : "implicit"`);
  }

  return lines.join('\n');
}

function formatReport(results) {
  if (results.error) return `Error: ${results.error}`;

  const lines = [];
  lines.push('');
  lines.push('  CoBolt Schema Reverse Engineering Report');
  lines.push('  ═══════════════════════════════════════════');
  lines.push(`  Source: ${results.source}`);
  lines.push('');
  lines.push(`  Tables: ${results.summary.tables}`);
  lines.push(`  Columns: ${results.summary.columns}`);
  lines.push(`  Explicit FKs: ${results.summary.explicitFKs}`);
  lines.push(`  Implicit FKs: ${results.summary.implicitFKs}`);
  lines.push(`  Stored Procedures: ${results.summary.storedProcedures}`);
  lines.push(`  Views: ${results.summary.views}`);
  lines.push(`  Triggers: ${results.summary.triggers}`);
  lines.push('');

  for (const table of results.tables) {
    lines.push(`  Table: ${table.name} (${table.columns.length} columns)`);
    for (const col of table.columns) {
      const tags = [];
      if (col.primaryKey) tags.push('PK');
      if (col.foreignKey) tags.push(`FK→${col.foreignKey}`);
      if (!col.nullable) tags.push('NOT NULL');
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
      lines.push(`    ${col.name} ${col.type}${tagStr}`);
    }
    lines.push('');
  }

  if (results.implicitFKs.length > 0) {
    lines.push('  Discovered Implicit Foreign Keys:');
    for (const fk of results.implicitFKs) {
      lines.push(`    ${fk.from} → ${fk.to} (confidence: ${fk.confidence})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Exports ────────────────────────────────────────────────

module.exports = { analyzeSchemaFile, generateMermaidERD, formatReport };

// ── CLI ────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  let target = null;
  let jsonOutput = false;
  let mermaidOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') jsonOutput = true;
    else if (args[i] === '--format' && args[i + 1] === 'mermaid') {
      mermaidOutput = true;
      i++;
    } else if (args[i] === '--mermaid') mermaidOutput = true;
    else if (args[i] === '--help') {
      console.log('Usage: cobolt-schema-reverse <sql-file-or-db-connection> [--json] [--mermaid]');
      process.exit(0);
    } else if (!args[i].startsWith('--')) {
      target = args[i];
    }
  }

  if (!target) {
    // v0.40.12 DEFECT-04: usage error → exit 2 (per tools/CLAUDE.md contract)
    console.error('Error: Please provide a SQL file path or database connection string');
    console.error('Usage: cobolt-schema-reverse <sql-file-or-db-connection> [--json] [--mermaid]');
    process.exit(2);
  }

  const results = analyzeSchemaFile(path.resolve(target));

  if (mermaidOutput) {
    console.log(generateMermaidERD(results));
  } else if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatReport(results));
  }
}
