/**
 * Detection results: stable IDs, one result per record + issue type, and the output file.
 * The detection timestamp is the "as of" moment of the run (the end of the reference day), not the machine clock, so two runs over
 * the same data produce byte-identical results.
 */
const fs = require('fs');
const path = require('path');
const { ISSUE_TYPES, ORDER } = require('./config/detectionRules');

function buildDetections(raw, referenceDate) {
  const seen = new Set();
  const unique = [];
  for (const f of raw) {
    const key = `${ISSUE_TYPES[f.issueType].entityType}|${f.entityId}|${f.issueType}`;
    if (seen.has(key)) continue; // the evaluation unit is the record + issue type: never counted twice
    seen.add(key);
    unique.push(f);
  }
  unique.sort((a, b) => ORDER.indexOf(a.issueType) - ORDER.indexOf(b.issueType) || a.entityId.localeCompare(b.entityId));
  return unique.map((f, i) => ({
    detection_id: `DET-${String(i + 1).padStart(6, '0')}`,
    issue_type: f.issueType,
    entity_type: ISSUE_TYPES[f.issueType].entityType,
    entity_id: f.entityId,
    related_customer_id: f.customer,
    description: f.description,
    severity: ISSUE_TYPES[f.issueType].severity,
    detection_timestamp: `${referenceDate}T23:59:59.000Z`,
  }));
}

function writeResults(file, { referenceDate, detections, perRule }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const byType = {};
  for (const d of detections) byType[d.issue_type] = (byType[d.issue_type] || 0) + 1;
  const rules = perRule.map(({ ms, ...rest }) => rest);
  fs.writeFileSync(file, JSON.stringify({ reference_date: referenceDate, total_detections: detections.length, detections_by_type: byType, rules, detections }, null, 2));
}

module.exports = { buildDetections, writeResults };
