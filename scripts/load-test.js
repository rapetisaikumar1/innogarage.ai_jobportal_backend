require('dotenv').config();

const jwt = require('jsonwebtoken');
const { performance } = require('perf_hooks');
const prisma = require('../src/config/database');
const config = require('../src/config');

const parseNumberArg = (name, fallback) => {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  const raw = arg ? arg.slice(prefix.length) : process.env[`LOAD_TEST_${name.toUpperCase()}`];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const hasFlag = (name) => process.argv.includes(`--${name}`);

const BASE_URL = process.env.LOAD_TEST_BASE_URL || 'http://localhost:5000/api';
const DURATION_SECONDS = parseNumberArg('duration', 20);
const CONCURRENCY = parseNumberArg('concurrency', 8);
const REQUEST_TIMEOUT_MS = parseNumberArg('timeoutMs', 20000);
const INCLUDE_WARMUP = !hasFlag('no-warmup');

const endpointCatalog = [
  { name: 'admin:my-students', role: 'ADMIN', path: '/admin/my-students' },
  { name: 'admin:mentor-slots', role: 'ADMIN', path: '/mentoring/my-slots' },
  { name: 'admin:mentor-bookings', role: 'ADMIN', path: '/mentoring/mentor-bookings' },
  { name: 'admin:requests', role: 'ADMIN', path: '/admin/requests' },
  { name: 'admin:technologies-light', role: 'ADMIN', path: '/admin/available-technologies?usage=false' },
  { name: 'admin:notifications-count', role: 'ADMIN', path: '/notifications/unread-count' },
  { name: 'admin:query-stats', role: 'ADMIN', path: '/queries/stats' },
  { name: 'admin:training-materials', role: 'ADMIN', path: '/training/materials' },
  { name: 'admin:chat-contacts', role: 'ADMIN', path: '/chat/contacts' },

  { name: 'super:analytics', role: 'SUPER_ADMIN', path: '/admin/analytics' },
  { name: 'super:students-summary', role: 'SUPER_ADMIN', path: '/admin/students?limit=500&summary=true' },
  { name: 'super:admins-summary', role: 'SUPER_ADMIN', path: '/admin/admins?summary=true' },
  { name: 'super:requests', role: 'SUPER_ADMIN', path: '/admin/requests' },
  { name: 'super:query-stats', role: 'SUPER_ADMIN', path: '/queries/stats' },
  { name: 'super:query-list', role: 'SUPER_ADMIN', path: '/queries/all' },
  { name: 'super:training-materials', role: 'SUPER_ADMIN', path: '/training/materials' },
  { name: 'super:chat-contacts', role: 'SUPER_ADMIN', path: '/chat/contacts' },

  { name: 'student:training-materials', role: 'STUDENT', path: '/training/materials' },
  { name: 'student:bookings', role: 'STUDENT', path: '/mentoring/my-bookings' },
  { name: 'student:notifications-count', role: 'STUDENT', path: '/notifications/unread-count' },
  { name: 'student:queries', role: 'STUDENT', path: '/queries/mine' },
  { name: 'student:chat-contacts', role: 'STUDENT', path: '/chat/contacts' },
  { name: 'student:achievers', role: 'STUDENT', path: '/achievers' },
  { name: 'student:shoutboard', role: 'STUDENT', path: '/shoutboard' },
];

const percentile = (values, percent) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
  return sorted[index];
};

const summarize = (records) => {
  const durations = records.map((record) => record.durationMs);
  const errors = records.filter((record) => !record.ok).length;
  const statusCounts = records.reduce((acc, record) => {
    const key = record.status || record.error || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    count: records.length,
    errors,
    errorRate: records.length ? (errors / records.length) * 100 : 0,
    min: Math.min(...durations),
    avg: durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length),
    p50: percentile(durations, 50),
    p90: percentile(durations, 90),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: Math.max(...durations),
    statusCounts,
  };
};

const formatMs = (value) => `${Math.round(value)}ms`;

const printSummary = (title, records, elapsedSeconds) => {
  const total = summarize(records);
  const throughput = records.length / Math.max(1, elapsedSeconds);
  console.log(`\n${title}`);
  console.log('='.repeat(title.length));
  console.log(`requests=${total.count} concurrency=${CONCURRENCY} duration=${elapsedSeconds.toFixed(1)}s rps=${throughput.toFixed(2)} errors=${total.errors} (${total.errorRate.toFixed(2)}%)`);
  console.log(`latency min=${formatMs(total.min)} avg=${formatMs(total.avg)} p50=${formatMs(total.p50)} p90=${formatMs(total.p90)} p95=${formatMs(total.p95)} p99=${formatMs(total.p99)} max=${formatMs(total.max)}`);
  console.log(`status=${JSON.stringify(total.statusCounts)}`);

  const grouped = new Map();
  records.forEach((record) => {
    if (!grouped.has(record.name)) grouped.set(record.name, []);
    grouped.get(record.name).push(record);
  });

  const rows = [...grouped.entries()]
    .map(([name, groupRecords]) => ({ name, ...summarize(groupRecords) }))
    .sort((left, right) => right.p95 - left.p95);

  console.log('\nPer endpoint, sorted by p95:');
  rows.forEach((row) => {
    console.log([
      row.name.padEnd(34),
      `n=${String(row.count).padStart(4)}`,
      `err=${String(row.errors).padStart(3)}`,
      `avg=${formatMs(row.avg).padStart(6)}`,
      `p50=${formatMs(row.p50).padStart(6)}`,
      `p90=${formatMs(row.p90).padStart(6)}`,
      `p95=${formatMs(row.p95).padStart(6)}`,
      `p99=${formatMs(row.p99).padStart(6)}`,
      `max=${formatMs(row.max).padStart(6)}`,
      `status=${JSON.stringify(row.statusCounts)}`,
    ].join('  '));
  });
};

const tokenFor = (user) => jwt.sign({ userId: user.id, role: user.role }, config.jwt.secret, { expiresIn: '2h' });

const fetchActiveUsers = async () => {
  const select = { id: true, email: true, fullName: true, role: true };
  const [admin, superAdmin, student] = await Promise.all([
    prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true }, select }),
    prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', isActive: true }, select }),
    prisma.user.findFirst({ where: { role: 'STUDENT', isActive: true }, select }),
  ]);

  return { ADMIN: admin, SUPER_ADMIN: superAdmin, STUDENT: student };
};

const requestEndpoint = async (endpoint, token) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = performance.now();

  try {
    const response = await fetch(`${BASE_URL}${endpoint.path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      name: endpoint.name,
      status: response.status,
      ok: response.ok,
      durationMs: performance.now() - start,
      bytes: body.length,
    };
  } catch (error) {
    return {
      name: endpoint.name,
      status: 0,
      ok: false,
      durationMs: performance.now() - start,
      error: error.name || 'REQUEST_ERROR',
      bytes: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const runWarmup = async (endpoints, tokens) => {
  for (const endpoint of endpoints) {
    await requestEndpoint(endpoint, tokens[endpoint.role]);
  }
};

const runLoad = async (endpoints, tokens) => {
  const records = [];
  const start = performance.now();
  const stopAt = start + DURATION_SECONDS * 1000;
  let nextIndex = 0;

  const worker = async () => {
    while (performance.now() < stopAt) {
      const endpoint = endpoints[nextIndex % endpoints.length];
      nextIndex += 1;
      records.push(await requestEndpoint(endpoint, tokens[endpoint.role]));
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { records, elapsedSeconds: (performance.now() - start) / 1000 };
};

const main = async () => {
  if (!config.jwt.secret) {
    throw new Error('JWT_SECRET is required for authenticated load testing');
  }

  const users = await fetchActiveUsers();
  const tokens = Object.fromEntries(
    Object.entries(users)
      .filter(([, user]) => Boolean(user))
      .map(([role, user]) => [role, tokenFor(user)])
  );
  const endpoints = endpointCatalog.filter((endpoint) => tokens[endpoint.role]);

  console.log(`base=${BASE_URL}`);
  console.log(`users=${Object.values(users).filter(Boolean).map((user) => `${user.role}:${user.email}`).join(', ')}`);
  console.log(`endpoints=${endpoints.length}`);

  if (endpoints.length === 0) {
    throw new Error('No active users found for load testing');
  }

  if (INCLUDE_WARMUP) {
    console.log('warmup=enabled');
    await runWarmup(endpoints, tokens);
  } else {
    console.log('warmup=disabled');
  }

  const { records, elapsedSeconds } = await runLoad(endpoints, tokens);
  printSummary('Load Test Summary', records, elapsedSeconds);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });