// Placement Readiness Dashboard — the "ONE core thing" the placement-prep
// wedge of this platform was missing: every AI feature (skills, resume,
// live interview bot, DSA practice, job tracker) already existed as its
// own island. This module reads across all of them (read-only — it does
// not touch or duplicate any of their tables) and produces:
//   1. a single 0-100 readiness score per student, with a breakdown and
//      concrete next-step gaps pointing at the real existing endpoints;
//   2. a placement-cell-wide dashboard (ranked list + pipeline funnel)
//      built entirely from real job_tracker_entries and job_applications
//      data — no invented numbers.
//
// Fully additive: no new tables, no changes to any existing file. It only
// SELECTs from tables that skills.js, resumeBuilder/resumeRoutes.js,
// liveInterviewBot.js, interviewMasteryCoach.js and jobTracker.js already
// own and maintain.

const { db } = require('./db');

// ---- weights for the composite score (sum to 1.0) -------------------
const WEIGHTS = {
  skills: 0.20,
  resume: 0.20,
  interview: 0.25,
  dsa: 0.15,
  jobActivity: 0.20,
};

function clamp(n, lo = 0, hi = 100) {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---- per-signal readers (all read-only, all existing tables) --------

function skillsSignal(studentId) {
  const row = db
    .prepare('SELECT COUNT(*) AS n, AVG(proficiency) AS avgProf FROM student_skills WHERE student_id = ?')
    .get(studentId);
  const n = row?.n || 0;
  const score = n > 0 ? clamp(row.avgProf) : 0;
  return { score: round1(score), skillsLogged: n };
}

function resumeSignal(studentId) {
  let row;
  try {
    row = db
      .prepare('SELECT COUNT(*) AS n, MAX(ats_score) AS bestAts FROM resumes WHERE user_id = ?')
      .get(studentId);
  } catch (e) {
    // resumes table is created lazily by resumeRoutes.js on first use;
    // if it doesn't exist yet for a fresh DB, treat as "no resume yet".
    return { score: 0, resumesBuilt: 0, bestAtsScore: null };
  }
  const n = row?.n || 0;
  const bestAts = row?.bestAts;
  const score = n > 0 ? clamp(bestAts != null ? bestAts : 40) : 0; // has a resume but never ATS-checked -> partial credit
  return { score: round1(score), resumesBuilt: n, bestAtsScore: bestAts != null ? round1(bestAts) : null };
}

function interviewSignal(studentId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS completed, AVG(overall_score) AS avgScore
       FROM live_interview_sessions WHERE student_id = ? AND status = 'completed'`
    )
    .get(studentId);
  const completed = row?.completed || 0;
  const avgScore = clamp(row?.avgScore);
  // reward doing more than one practice round; a single lucky session
  // shouldn't count the same as sustained practice
  const volumeFactor = Math.min(1, completed / 3);
  const score = completed > 0 ? clamp(avgScore * volumeFactor + avgScore * 0.3 * (1 - volumeFactor)) : 0;
  return { score: round1(score), sessionsCompleted: completed, avgSessionScore: completed > 0 ? round1(avgScore) : null };
}

function dsaSignal(studentId) {
  const row = db
    .prepare('SELECT COUNT(*) AS attempts, AVG(score) AS avgScore FROM dsa_practice_attempts WHERE student_id = ?')
    .get(studentId);
  const attempts = row?.attempts || 0;
  const avgScore = clamp(row?.avgScore);
  const volumeFactor = Math.min(1, attempts / 5);
  const score = attempts > 0 ? clamp(avgScore * volumeFactor + avgScore * 0.3 * (1 - volumeFactor)) : 0;
  return { score: round1(score), attemptsLogged: attempts, avgAttemptScore: attempts > 0 ? round1(avgScore) : null };
}

function jobActivitySignal(studentId) {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('applied','interview','offer') THEN 1 ELSE 0 END) AS applied,
         SUM(CASE WHEN status = 'interview' THEN 1 ELSE 0 END) AS interview,
         SUM(CASE WHEN status = 'offer' THEN 1 ELSE 0 END) AS offer
       FROM job_tracker_entries WHERE student_id = ?`
    )
    .get(studentId);
  const applied = row?.applied || 0;
  const interview = row?.interview || 0;
  const offer = row?.offer || 0;
  const raw = applied * 8 + interview * 15 + offer * 30;
  return { score: round1(clamp(raw)), applied, interview, offer };
}

function readinessLabel(score) {
  if (score >= 75) return 'Placement Ready';
  if (score >= 45) return 'Building Readiness';
  return 'Needs Attention';
}

// Gaps point to the REAL, already-mounted student endpoints, so this
// dashboard is immediately actionable rather than aspirational.
function buildGaps({ skills, resume, interview, dsa, jobActivity }) {
  const gaps = [];
  if (skills.score < 50) {
    gaps.push({
      area: 'skills',
      message: skills.skillsLogged === 0
        ? 'No skills logged yet — add your technical and soft skills.'
        : 'Skill proficiency is low — raise it or add more skills.',
      action: 'PUT /api/student/skills',
    });
  }
  if (resume.score < 50) {
    gaps.push({
      area: 'resume',
      message: resume.resumesBuilt === 0
        ? 'No resume built yet.'
        : 'Resume exists but has a low (or missing) ATS score — run it through the ATS checker again.',
      action: 'POST /api/resume',
    });
  }
  if (interview.score < 50) {
    gaps.push({
      area: 'interview practice',
      message: interview.sessionsCompleted === 0
        ? 'No mock interview sessions completed yet.'
        : 'Interview practice score is low — do a few more rounds to build consistency.',
      action: 'POST /api/student/interview-coach/live-interview/sessions',
    });
  }
  if (dsa.score < 50) {
    gaps.push({
      area: 'DSA practice',
      message: dsa.attemptsLogged === 0
        ? 'No DSA practice attempts logged yet.'
        : 'DSA attempt scores are low — practice more problems in your weak topics.',
      action: 'POST /api/student/interview-coach/dsa/problems',
    });
  }
  if (jobActivity.score < 30) {
    gaps.push({
      area: 'job search activity',
      message: 'Few or no job applications tracked — start applying and log them.',
      action: 'POST /api/student/job-tracker',
    });
  }
  return gaps;
}

function computeReadiness(studentId) {
  const skills = skillsSignal(studentId);
  const resume = resumeSignal(studentId);
  const interview = interviewSignal(studentId);
  const dsa = dsaSignal(studentId);
  const jobActivity = jobActivitySignal(studentId);

  const overall =
    skills.score * WEIGHTS.skills +
    resume.score * WEIGHTS.resume +
    interview.score * WEIGHTS.interview +
    dsa.score * WEIGHTS.dsa +
    jobActivity.score * WEIGHTS.jobActivity;

  const breakdown = { skills, resume, interview, dsa, jobActivity };

  return {
    studentId,
    overallScore: round1(overall),
    label: readinessLabel(overall),
    breakdown,
    weights: WEIGHTS,
    gaps: buildGaps(breakdown),
    computedAt: new Date().toISOString(),
  };
}

// ---- placement-cell-wide view ----------------------------------------

function listStudents() {
  return db.prepare(`SELECT id, name, email FROM users WHERE role = 'student' ORDER BY name ASC`).all();
}

function dashboard() {
  const students = listStudents();
  const rows = students.map((s) => {
    const r = computeReadiness(s.id);
    return { studentId: s.id, name: s.name, email: s.email, overallScore: r.overallScore, label: r.label };
  });
  rows.sort((a, b) => b.overallScore - a.overallScore);

  const funnel = { ready: 0, building: 0, needsAttention: 0 };
  for (const r of rows) {
    if (r.label === 'Placement Ready') funnel.ready += 1;
    else if (r.label === 'Building Readiness') funnel.building += 1;
    else funnel.needsAttention += 1;
  }

  // Pipeline funnel from real job-tracker activity across all students.
  const pipeline = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('applied','interview','offer') THEN 1 ELSE 0 END) AS applied,
         SUM(CASE WHEN status = 'interview' THEN 1 ELSE 0 END) AS interview,
         SUM(CASE WHEN status = 'offer' THEN 1 ELSE 0 END) AS offer
       FROM job_tracker_entries`
    )
    .get();

  return {
    totalStudents: students.length,
    readinessFunnel: funnel,
    applicationPipeline: {
      applied: pipeline?.applied || 0,
      interview: pipeline?.interview || 0,
      offer: pipeline?.offer || 0,
    },
    students: rows,
    computedAt: new Date().toISOString(),
  };
}

module.exports = { computeReadiness, dashboard, listStudents };
