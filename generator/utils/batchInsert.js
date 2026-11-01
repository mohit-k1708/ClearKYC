/**
 * Bulk insertion with timing. Rows are built in memory with their final internal ids, then written with createMany in batches:
 * no query per record, no lookups inside loops. Each stage is timed for the performance report.
 */
const { performance } = require('perf_hooks');

class Metrics {
  constructor() {
    this.stages = [];
    this.errors = [];
    this.started = performance.now();
  }

  record(entity, count, ms, kind = 'insert') {
    this.stages.push({ entity, kind, records: count, ms: Math.round(ms), recordsPerSecond: ms > 0 ? Math.round((count / ms) * 1000) : null });
  }

  error(entity, message) {
    this.errors.push({ entity, message: String(message).slice(0, 400) });
  }

  async time(entity, kind, count, fn) {
    const t0 = performance.now();
    try {
      const result = await fn();
      this.record(entity, typeof count === 'function' ? count(result) : count, performance.now() - t0, kind);
      return result;
    } catch (err) {
      this.error(entity, err.message);
      throw err;
    }
  }

  totalMs() {
    return Math.round(performance.now() - this.started);
  }
}

/** Writes `rows` into a Prisma model in batches. Returns the number of rows written. */
async function insertBatches(prisma, metrics, entity, model, rows, batchSize) {
  if (rows.length === 0) {
    metrics.record(entity, 0, 0);
    return 0;
  }
  return metrics.time(entity, 'insert', rows.length, async () => {
    for (let i = 0; i < rows.length; i += batchSize) {
      await prisma[model].createMany({ data: rows.slice(i, i + batchSize) });
    }
    return rows.length;
  });
}

/** After inserting explicit ids, move the serial sequence of a table past the highest id so the application carries on correctly. */
async function syncSerial(prisma, table) {
  await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM "${table}"), 1), (SELECT COUNT(*) > 0 FROM "${table}"))`);
}

async function setSequence(prisma, sequence, lastValue) {
  await prisma.$executeRawUnsafe(`SELECT setval('${sequence}', ${Math.max(Number(lastValue), 1)}, ${Number(lastValue) > 0})`);
}

module.exports = { Metrics, insertBatches, syncSerial, setSequence };
