// /api/student/placement-readiness — a student's own composite readiness
// score, breakdown by signal, and concrete next-step gaps.
//
// /api/placements/readiness-dashboard — the placement cell's ranked,
// college-wide view: who's ready, who isn't, and the real application
// pipeline funnel.
//
// Fully additive: new file, new mounts only, in the same style as every
// other route file in this project (skillsRoutes.js, jobTrackerRoutes.js,
// etc.) — nothing existing is changed.

const express = require('express');
const { requireAuth, requireRole } = require('../auth');
const readiness = require('../placementReadiness');
const audit = require('../audit');

function createStudentReadinessRouter() {
  const router = express.Router();
  router.use(requireAuth, requireRole('student'));

  router.get('/', (req, res) => {
    try {
      const result = readiness.computeReadiness(req.user.id);
      res.json({ ok: true, readiness: result });
    } catch (e) {
      res.status(e.status || 500).json({ ok: false, error: e.message || 'Failed to compute readiness score' });
    }
  });

  return router;
}

function createPlacementReadinessDashboardRouter() {
  const router = express.Router();
  // Same role convention as placementRoutes.js: faculty running placement
  // drives, admin, and the AI-admin portal can all see the cell-wide view.
  router.use(requireAuth, requireRole('faculty', 'admin', 'ai-admin'));

  router.get('/', (req, res) => {
    try {
      const result = readiness.dashboard();
      audit.record(req.user.id, 'view', 'placement_readiness_dashboard', null, { totalStudents: result.totalStudents });
      res.json({ ok: true, dashboard: result });
    } catch (e) {
      res.status(e.status || 500).json({ ok: false, error: e.message || 'Failed to build readiness dashboard' });
    }
  });

  // Drill into one student's score from the placement-cell view (e.g. the
  // TPO clicks a name in the ranked list).
  router.get('/students/:studentId', (req, res) => {
    try {
      const result = readiness.computeReadiness(req.params.studentId);
      res.json({ ok: true, readiness: result });
    } catch (e) {
      res.status(e.status || 500).json({ ok: false, error: e.message || 'Failed to compute readiness score' });
    }
  });

  return router;
}

module.exports = { createStudentReadinessRouter, createPlacementReadinessDashboardRouter };
