// INFOHAS Attendance System - SaaS Multi-Tenant Cloudflare Worker API
// D1 Database Backend with Tenant Isolation

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ success: false, error: message }, status);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Normalize null values to empty strings to prevent 'undefined' in frontend
function nullToEmpty(obj) {
  if (Array.isArray(obj)) return obj.map(nullToEmpty);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = v === null ? '' : v;
    }
    return result;
  }
  return obj;
}

// Enhanced auth check with tenant context
async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  try {
    const session = await env.DB.prepare(
      `SELECT s.*, u.username, u.role, u.full_name, u.tenant_id, u.is_super_admin,
              t.name as tenant_name, t.slug as tenant_slug, t.status as tenant_status,
              t.primary_color, t.secondary_color, t.logo_url, t.language as tenant_language,
              t.max_students, t.max_users,
              sub.plan as subscription_plan, sub.status as subscription_status
       FROM sessions s 
       JOIN users u ON s.user_id = u.id 
       LEFT JOIN tenants t ON u.tenant_id = t.id
       LEFT JOIN subscriptions sub ON sub.tenant_id = t.id AND sub.status = 'active'
       WHERE s.token = ? AND s.expires_at > datetime("now")`
    ).bind(token).first();
    return session;
  } catch (e) {
    // Fallback for databases without tenant tables yet (backward compat)
    try {
      const session = await env.DB.prepare(
        'SELECT s.*, u.username, u.role, u.full_name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND expires_at > datetime("now")'
      ).bind(token).first();
      return session;
    } catch (e2) {
      return null;
    }
  }
}

// ==================== ROUTER ====================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check
    if (path === '/api/health') {
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0-saas' });
    }

    // ==================== AUTH ROUTES (no auth required) ====================
    
    // Registration - Create new tenant + admin user
    if (path === '/api/auth/register' && method === 'POST') {
      try {
        const { schoolName, slug, adminName, adminEmail, adminPassword, country, language } = await request.json();
        if (!schoolName || !slug || !adminName || !adminEmail || !adminPassword)
          return errorResponse('All fields are required');
        if (adminPassword.length < 6)
          return errorResponse('Password must be at least 6 characters');
        if (!/^[a-z0-9-]+$/.test(slug))
          return errorResponse('School URL must be lowercase letters, numbers, and hyphens only');

        // Check slug uniqueness
        const existing = await env.DB.prepare('SELECT id FROM tenants WHERE slug = ?').bind(slug).first();
        if (existing) return errorResponse('This school URL is already taken', 409);

        // Check email uniqueness
        const existingUser = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(adminEmail).first();
        if (existingUser) return errorResponse('An account with this email already exists', 409);

        const tenantId = generateId();
        const userId = generateId();

        // Create tenant
        await env.DB.prepare(
          'INSERT INTO tenants (id, slug, name, owner_id, country, language) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(tenantId, slug, schoolName, userId, country || 'MA', language || 'en').run();

        // Create admin user with tenant context
        await env.DB.prepare(
          'INSERT INTO users (id, username, password, role, full_name, email, tenant_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
        ).bind(userId, adminEmail, adminPassword, 'admin', adminName, adminEmail, tenantId).run();

        // Create free subscription
        await env.DB.prepare(
          'INSERT INTO subscriptions (id, tenant_id, plan, status) VALUES (?, ?, ?, ?)'
        ).bind(generateId(), tenantId, 'free', 'active').run();

        // Create session
        const token = generateId() + generateId();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare(
          'INSERT INTO sessions (id, user_id, token, expires_at, tenant_id) VALUES (?, ?, ?, ?, ?)'
        ).bind(generateId(), userId, token, expiresAt, tenantId).run();

        return jsonResponse({
          success: true,
          token,
          tenant: { id: tenantId, slug, name: schoolName, primary_color: '#6366f1', secondary_color: '#f1f5f9' },
          user: { id: userId, username: adminEmail, role: 'admin', full_name: adminName, email: adminEmail, tenant_id: tenantId, is_super_admin: false }
        }, 201);
      } catch (e) {
        return errorResponse('Registration failed: ' + e.message, 500);
      }
    }

    // Tenant lookup (for login page - check if slug exists)
    if (path === '/api/tenants/lookup' && method === 'GET') {
      const slug = url.searchParams.get('slug');
      if (!slug) return errorResponse('Slug is required');
      try {
        const tenant = await env.DB.prepare(
          'SELECT id, slug, name, logo_url, primary_color, secondary_color, language FROM tenants WHERE slug = ? AND status = ?'
        ).bind(slug, 'active').first();
        if (!tenant) return errorResponse('School not found', 404);
        return jsonResponse({ success: true, data: nullToEmpty(tenant) });
      } catch (e) {
        return errorResponse('Lookup failed: ' + e.message, 500);
      }
    }

    // Login - tenant-aware
    if (path === '/api/auth/login' && method === 'POST') {
      try {
        const { username, password, slug } = await request.json();
        if (!username || !password) return errorResponse('Username and password required');

        let tenantId = null;
        let tenantInfo = null;

        // If slug provided, look up tenant
        if (slug) {
          try {
            const tenant = await env.DB.prepare(
              'SELECT id, slug, name, status, primary_color, secondary_color, logo_url, language FROM tenants WHERE slug = ?'
            ).bind(slug).first();
            if (!tenant) return errorResponse('School not found', 404);
            if (tenant.status === 'suspended') return errorResponse('School account is suspended', 403);
            tenantId = tenant.id;
            tenantInfo = tenant;
          } catch (e) {
            // Tenants table might not exist yet - backward compat
          }
        }

        // Build query with optional tenant filter
        let query = 'SELECT * FROM users WHERE username = ? AND is_active = 1';
        const params = [username];
        if (tenantId) {
          query += ' AND tenant_id = ?';
          params.push(tenantId);
        }

        const user = await env.DB.prepare(query).bind(...params).first();
        if (!user) return errorResponse('Invalid credentials', 401);
        if (user.password !== password) return errorResponse('Invalid credentials', 401);

        // Create session with tenant context
        const token = generateId() + generateId();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        try {
          await env.DB.prepare(
            'INSERT INTO sessions (id, user_id, token, expires_at, tenant_id) VALUES (?, ?, ?, ?, ?)'
          ).bind(generateId(), user.id, token, expiresAt, user.tenant_id || null).run();
        } catch (e) {
          // Fallback without tenant_id column
          await env.DB.prepare(
            'INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)'
          ).bind(generateId(), user.id, token, expiresAt).run();
        }

        return jsonResponse({
          success: true,
          token,
          tenant: tenantInfo ? { id: tenantInfo.id, slug: tenantInfo.slug, name: tenantInfo.name, primary_color: tenantInfo.primary_color, secondary_color: tenantInfo.secondary_color, logo_url: tenantInfo.logo_url } : null,
          user: { 
            id: user.id, username: user.username, role: user.role, 
            full_name: user.full_name, email: user.email, photo: user.photo,
            tenant_id: user.tenant_id || null, is_super_admin: user.is_super_admin || false
          }
        });
      } catch (e) {
        return errorResponse('Login failed: ' + e.message, 500);
      }
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const session = await authenticate(request, env);
      if (session) {
        await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(session.token).run();
      }
      return jsonResponse({ success: true });
    }

    // Change Password
    if (path === '/api/auth/change-password' && method === 'POST') {
      const session = await authenticate(request, env);
      if (!session) return errorResponse('Unauthorized', 401);
      try {
        const { currentPassword, newPassword } = await request.json();
        if (!currentPassword || !newPassword) return errorResponse('Current password and new password are required');
        if (newPassword.length < 4) return errorResponse('New password must be at least 4 characters');
        const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
        if (!user || user.password !== currentPassword) return errorResponse('Current password is incorrect', 401);
        await env.DB.prepare('UPDATE users SET password = ?, updated_at = datetime("now") WHERE id = ?')
          .bind(newPassword, session.user_id).run();
        return jsonResponse({ success: true, message: 'Password changed successfully' });
      } catch (e) {
        return errorResponse('Failed to change password: ' + e.message, 500);
      }
    }

    // ==================== AUTHENTICATED ROUTES ====================
    const session = await authenticate(request, env);
    if (!session && !path.startsWith('/api/auth/')) {
      return errorResponse('Unauthorized', 401);
    }

    // Extract tenant context
    const tenantId = session.tenant_id || null;
    const isSuperAdmin = session.is_super_admin === 1 || session.is_super_admin === true;

    // ==================== SUPER-ADMIN ROUTES ====================
    if (path.startsWith('/api/saas/') && isSuperAdmin) {
      try {
        // GET /api/saas/tenants - List all tenants
        if (path === '/api/saas/tenants' && method === 'GET') {
          const tenants = await env.DB.prepare(
            `SELECT t.*, 
              (SELECT COUNT(*) FROM users WHERE tenant_id = t.id AND is_active = 1) as user_count,
              (SELECT COUNT(*) FROM students WHERE tenant_id = t.id) as student_count,
              sub.plan, sub.status as subscription_status
            FROM tenants t LEFT JOIN subscriptions sub ON sub.tenant_id = t.id
            ORDER BY t.created_at DESC`
          ).all();
          return jsonResponse({ success: true, data: nullToEmpty(tenants.results) });
        }

        // GET /api/saas/tenants/:id
        if (path.match(/^\/api\/saas\/tenants\/[^/]+$/) && method === 'GET') {
          const id = path.split('/').pop();
          const tenant = await env.DB.prepare(
            `SELECT t.*, sub.plan, sub.status as subscription_status FROM tenants t LEFT JOIN subscriptions sub ON sub.tenant_id = t.id WHERE t.id = ?`
          ).bind(id).first();
          if (!tenant) return errorResponse('Tenant not found', 404);
          return jsonResponse({ success: true, data: nullToEmpty(tenant) });
        }

        // PUT /api/saas/tenants/:id - Update tenant
        if (path.match(/^\/api\/saas\/tenants\/[^/]+$/) && method === 'PUT') {
          const id = path.split('/').pop();
          const body = await request.json();
          const sets = [];
          const vals = [];
          for (const [k, v] of Object.entries(body)) {
            if (['name', 'slug', 'status', 'max_students', 'max_users', 'primary_color', 'secondary_color', 'logo_url', 'language', 'country'].includes(k)) {
              sets.push(`${k} = ?`);
              vals.push(v === undefined ? null : v);
            }
          }
          if (sets.length === 0) return errorResponse('No valid fields to update');
          sets.push('updated_at = datetime("now")');
          vals.push(id);
          await env.DB.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
          return jsonResponse({ success: true });
        }

        // DELETE /api/saas/tenants/:id - Delete tenant and all its data
        if (path.match(/^\/api\/saas\/tenants\/[^/]+$/) && method === 'DELETE') {
          const id = path.split('/').pop();
          const tables = ['sessions', 'task_comments', 'task_files', 'tasks', 'incident_files', 'incidents', 'attendance', 'students', 'modules', 'classes', 'settings', 'subscriptions', 'tenant_invitations', 'users'];
          for (const table of tables) {
            try { await env.DB.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).bind(id).run(); } catch(e) {}
          }
          await env.DB.prepare('DELETE FROM tenants WHERE id = ?').bind(id).run();
          return jsonResponse({ success: true });
        }

        // GET /api/saas/stats - Platform statistics
        if (path === '/api/saas/stats' && method === 'GET') {
          const totalTenants = await env.DB.prepare('SELECT COUNT(*) as count FROM tenants').first();
          const activeTenants = await env.DB.prepare("SELECT COUNT(*) as count FROM tenants WHERE status = 'active'").first();
          const totalStudents = await env.DB.prepare('SELECT COUNT(*) as count FROM students').first();
          const totalUsers = await env.DB.prepare('SELECT COUNT(*) as count FROM users WHERE is_active = 1').first();
          return jsonResponse({
            success: true,
            data: { totalTenants: totalTenants.count, activeTenants: activeTenants.count, totalStudents: totalStudents.count, totalUsers: totalUsers.count }
          });
        }

        return errorResponse('Not found', 404);
      } catch (e) {
        return errorResponse('Super-admin error: ' + e.message, 500);
      }
    }

    // ==================== SaaS MIGRATION ====================
    if (path === '/api/saas-migrate' && method === 'POST') {
      if (session.role !== 'admin') return errorResponse('Forbidden', 403);
      try {
        const migrations = [
          // New tables
          `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, logo_url TEXT, primary_color TEXT DEFAULT '#6366f1', secondary_color TEXT DEFAULT '#f1f5f9', country TEXT DEFAULT 'MA', language TEXT DEFAULT 'en', max_students INTEGER DEFAULT 100, max_users INTEGER DEFAULT 5, status TEXT DEFAULT 'active', owner_id TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`,
          `CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, plan TEXT DEFAULT 'free', stripe_customer_id TEXT, stripe_subscription_id TEXT, status TEXT DEFAULT 'active', trial_ends_at TEXT, current_period_start TEXT, current_period_end TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (tenant_id) REFERENCES tenants(id))`,
          `CREATE TABLE IF NOT EXISTS tenant_invitations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT DEFAULT 'employee', token TEXT UNIQUE NOT NULL, invited_by TEXT NOT NULL, expires_at TEXT NOT NULL, accepted_at TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (tenant_id) REFERENCES tenants(id))`,
          // Add tenant_id to all existing tables
          'ALTER TABLE users ADD COLUMN tenant_id TEXT',
          'ALTER TABLE users ADD COLUMN is_super_admin INTEGER DEFAULT 0',
          'ALTER TABLE sessions ADD COLUMN tenant_id TEXT',
          'ALTER TABLE students ADD COLUMN tenant_id TEXT',
          'ALTER TABLE attendance ADD COLUMN tenant_id TEXT',
          'ALTER TABLE classes ADD COLUMN tenant_id TEXT',
          'ALTER TABLE modules ADD COLUMN tenant_id TEXT',
          'ALTER TABLE tasks ADD COLUMN tenant_id TEXT',
          'ALTER TABLE task_files ADD COLUMN tenant_id TEXT',
          'ALTER TABLE task_comments ADD COLUMN tenant_id TEXT',
          'ALTER TABLE incidents ADD COLUMN tenant_id TEXT',
          'ALTER TABLE incident_files ADD COLUMN tenant_id TEXT',
          'ALTER TABLE settings ADD COLUMN tenant_id TEXT',
          // Indexes
          'CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug)',
          'CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id)',
          'CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)',
          'CREATE INDEX IF NOT EXISTS idx_students_tenant ON students(tenant_id)',
          'CREATE INDEX IF NOT EXISTS idx_attendance_tenant ON attendance(tenant_id)',
          'CREATE INDEX IF NOT EXISTS idx_classes_tenant ON classes(tenant_id)',
          'CREATE INDEX IF NOT EXISTS idx_modules_tenant ON modules(tenant_id)',
          'CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id)',
          'CREATE INDEX IF NOT EXISTS idx_incidents_tenant ON incidents(tenant_id)',
          'CREATE INDEX IF NOT EXISTS idx_settings_tenant ON settings(tenant_id)',
        ];

        const results = [];
        for (const sql of migrations) {
          try {
            await env.DB.prepare(sql).run();
            results.push({ sql: sql.substring(0, 80), status: 'success' });
          } catch (e) {
            results.push({ sql: sql.substring(0, 80), status: 'skipped', reason: e.message });
          }
        }

        // Backfill: Create default tenant for existing data
        const defaultTenantId = 'tenant_default_001';
        try {
          const adminUser = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first();
          await env.DB.prepare(
            'INSERT OR IGNORE INTO tenants (id, slug, name, status, owner_id) VALUES (?, ?, ?, ?, ?)'
          ).bind(defaultTenantId, 'default', 'Default School', 'active', adminUser?.id || null).run();

          // Backfill tenant_id on all tables
          const backfillTables = ['users', 'students', 'attendance', 'classes', 'modules', 'tasks', 'task_files', 'task_comments', 'incidents', 'incident_files', 'settings'];
          for (const table of backfillTables) {
            try {
              await env.DB.prepare(`UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL`).bind(defaultTenantId).run();
            } catch(e) {}
          }

          // Create default subscription
          await env.DB.prepare(
            'INSERT OR IGNORE INTO subscriptions (id, tenant_id, plan, status) VALUES (?, ?, ?, ?)'
          ).bind('sub_default_001', defaultTenantId, 'pro', 'active').run();

          // Make existing admin a super_admin
          if (adminUser) {
            await env.DB.prepare('UPDATE users SET is_super_admin = 1 WHERE id = ?').bind(adminUser.id).run();
          }
        } catch (e) {
          results.push({ sql: 'backfill', status: 'error', reason: e.message });
        }

        return jsonResponse({ success: true, data: results });
      } catch (e) {
        return errorResponse('Migration failed: ' + e.message, 500);
      }
    }

    // ==================== REGULAR AUTHENTICATED ROUTES ====================
    try {
      // ==================== USERS ====================
      if (path === '/api/users' && method === 'GET') {
        let query = 'SELECT id, username, role, full_name, email, phone, photo, department, is_active, created_at, updated_at FROM users';
        const params = [];
        if (tenantId) { query += ' WHERE tenant_id = ?'; params.push(tenantId); }
        const users = await env.DB.prepare(query).bind(...params).all();
        return jsonResponse({ success: true, data: nullToEmpty(users.results) });
      }

      if (path === '/api/users' && method === 'POST') {
        if (session.role !== 'admin') return errorResponse('Forbidden', 403);
        const body = await request.json();
        const id = generateId();
        try {
          await env.DB.prepare(
            'INSERT INTO users (id, username, password, role, full_name, email, phone, photo, department, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, body.username, body.password || 'employee123', body.role || 'employee', body.full_name, body.email || null, body.phone || null, body.photo || null, body.department || null, tenantId).run();
        } catch (e) {
          await env.DB.prepare(
            'INSERT INTO users (id, username, password, role, full_name, email, phone, photo, department) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, body.username, body.password || 'employee123', body.role || 'employee', body.full_name, body.email || null, body.phone || null, body.photo || null, body.department || null).run();
        }
        return jsonResponse({ success: true, data: { id, ...body } }, 201);
      }

      if (path.match(/^\/api\/users\/[^/]+$/) && method === 'PUT') {
        const id = path.split('/').pop();
        const body = await request.json();
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(body)) {
          if (['full_name', 'email', 'phone', 'photo', 'department', 'is_active', 'role', 'password'].includes(k)) {
            sets.push(`${k} = ?`);
            vals.push(v === undefined ? null : v);
          }
        }
        if (sets.length === 0) return errorResponse('No valid fields to update');
        sets.push('updated_at = datetime("now")');
        vals.push(id);
        if (tenantId) { sets.push('tenant_id = ?'); vals.push(tenantId); }
        await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return jsonResponse({ success: true });
      }

      if (path.match(/^\/api\/users\/[^/]+$/) && method === 'DELETE') {
        if (session.role !== 'admin') return errorResponse('Forbidden', 403);
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
      }

      // ==================== STUDENTS ====================
      if (path === '/api/students' && method === 'GET') {
        let query = 'SELECT * FROM students';
        const params = [];
        if (tenantId) { query += ' WHERE tenant_id = ?'; params.push(tenantId); }
        query += ' ORDER BY created_at DESC';
        const students = await env.DB.prepare(query).bind(...params).all();
        const validStudents = students.results
          .filter(s => (s.first_name || '').trim() !== '')
          .map(nullToEmpty);
        return jsonResponse({ success: true, data: validStudents });
      }

      if (path === '/api/students' && method === 'POST') {
        const body = await request.json();
        const id = body.id || generateId();
        const studentId = body.student_id || body.studentId || id.substring(0, 8).toUpperCase();
        const firstName = body.first_name ?? '';
        const lastName = body.last_name ?? '';
        const email = body.email ?? null;
        const phone = body.phone ?? null;
        const className = body.class ?? null;
        const groupName = body.group_name ?? null;
        const academicYear = body.academic_year ?? null;
        const status = body.status ?? 'active';
        const photo = body.photo ?? null;
        const enrollmentDate = body.enrollment_date ?? null;
        const notes = body.notes ?? null;
        const guardianName = body.guardian_name ?? null;
        const guardianPhone = body.guardian_phone ?? body.phone ?? null;
        const address = body.address ?? null;
        try {
          await env.DB.prepare(
            'INSERT INTO students (id, tenant_id, first_name, last_name, email, phone, class, group_name, academic_year, status, photo, enrollment_date, notes, guardian_name, guardian_phone, student_id, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, tenantId, firstName, lastName, email, phone, className, groupName, academicYear, status, photo, enrollmentDate, notes, guardianName, guardianPhone, studentId, address).run();
        } catch (e) {
          // Fallback without tenant_id
          await env.DB.prepare(
            'INSERT INTO students (id, first_name, last_name, email, phone, class, group_name, academic_year, status, photo, enrollment_date, notes, guardian_name, guardian_phone, student_id, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, firstName, lastName, email, phone, className, groupName, academicYear, status, photo, enrollmentDate, notes, guardianName, guardianPhone, studentId, address).run();
        }
        return jsonResponse({ success: true, data: { id, ...body } }, 201);
      }

      if (path === '/api/students/batch-assign-class' && method === 'POST') {
        const body = await request.json();
        const { studentIds, classId } = body;
        if (!Array.isArray(studentIds) || studentIds.length === 0) return errorResponse('studentIds array is required');
        if (!classId) return errorResponse('classId is required');
        let updated = 0;
        for (const sid of studentIds) {
          await env.DB.prepare('UPDATE students SET class = ?, group_name = ?, updated_at = datetime("now") WHERE id = ?')
            .bind(classId, classId, sid).run();
          updated++;
        }
        return jsonResponse({ success: true, data: { updated, classId } });
      }

      if (path.match(/^\/api\/students\/[^/]+$/) && method === 'PUT') {
        const id = path.split('/').pop();
        const body = await request.json();
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(body)) {
          if (['first_name', 'last_name', 'email', 'phone', 'class', 'group_name', 'academic_year', 'status', 'photo', 'enrollment_date', 'notes', 'guardian_name', 'guardian_phone', 'student_id', 'address'].includes(k)) {
            sets.push(`${k} = ?`);
            vals.push(v === undefined ? null : v);
          }
        }
        if (sets.length === 0) return errorResponse('No valid fields to update');
        sets.push('updated_at = datetime("now")');
        vals.push(id);
        await env.DB.prepare(`UPDATE students SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return jsonResponse({ success: true });
      }

      if (path.match(/^\/api\/students\/[^/]+$/) && method === 'DELETE') {
        if (session.role !== 'admin') return errorResponse('Forbidden', 403);
        const id = path.split('/').pop();
        try { await env.DB.prepare('DELETE FROM attendance WHERE student_id = ?').bind(id).run(); } catch(e) {}
        try { await env.DB.prepare('DELETE FROM incidents WHERE student_id = ?').bind(id).run(); } catch(e) {}
        await env.DB.prepare('DELETE FROM students WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
      }

      // ==================== ATTENDANCE ====================
      if (path === '/api/attendance' && method === 'GET') {
        const date = url.searchParams.get('date');
        const classFilter = url.searchParams.get('class');
        let query = 'SELECT a.*, s.first_name, s.last_name FROM attendance a JOIN students s ON a.student_id = s.id WHERE 1=1';
        const params = [];
        if (tenantId) { query += ' AND a.tenant_id = ?'; params.push(tenantId); }
        if (date) { query += ' AND a.date = ?'; params.push(date); }
        if (classFilter) { query += ' AND a.class = ?'; params.push(classFilter); }
        query += ' ORDER BY a.date DESC';
        const attendance = await env.DB.prepare(query).bind(...params).all();
        return jsonResponse({ success: true, data: nullToEmpty(attendance.results) });
      }

      if (path === '/api/attendance' && method === 'POST') {
        const body = await request.json();
        if (Array.isArray(body)) {
          const results = [];
          for (const record of body) {
            const id = generateId();
            try {
              await env.DB.prepare(
                'INSERT OR REPLACE INTO attendance (id, tenant_id, student_id, date, status, class, module, notes, marked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
              ).bind(id, tenantId, record.student_id, record.date, record.status, record.class || null, record.module || null, record.notes || null, session.user_id).run();
            } catch(e) {
              await env.DB.prepare(
                'INSERT OR REPLACE INTO attendance (id, student_id, date, status, class, module, notes, marked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
              ).bind(id, record.student_id, record.date, record.status, record.class || null, record.module || null, record.notes || null, session.user_id).run();
            }
            results.push(id);
          }
          return jsonResponse({ success: true, data: { count: results.length } }, 201);
        } else {
          const id = generateId();
          try {
            await env.DB.prepare(
              'INSERT OR REPLACE INTO attendance (id, tenant_id, student_id, date, status, class, module, notes, marked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(id, tenantId, body.student_id, body.date, body.status, body.class || null, body.module || null, body.notes || null, session.user_id).run();
          } catch(e) {
            await env.DB.prepare(
              'INSERT OR REPLACE INTO attendance (id, student_id, date, status, class, module, notes, marked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(id, body.student_id, body.date, body.status, body.class || null, body.module || null, body.notes || null, session.user_id).run();
          }
          return jsonResponse({ success: true, data: { id, ...body } }, 201);
        }
      }

      if (path.match(/^\/api\/attendance\/[^/]+$/) && method === 'PUT') {
        const id = path.split('/').pop();
        const body = await request.json();
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(body)) {
          if (['student_id', 'date', 'status', 'class', 'module', 'notes'].includes(k)) {
            sets.push(`${k} = ?`);
            vals.push(v === undefined ? null : v);
          }
        }
        if (sets.length === 0) return errorResponse('No valid fields to update');
        vals.push(id);
        await env.DB.prepare(`UPDATE attendance SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return jsonResponse({ success: true });
      }

      if (path.match(/^\/api\/attendance\/[^/]+$/) && method === 'DELETE') {
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM attendance WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
      }

      // ==================== CLASSES ====================
      if (path === '/api/classes' && method === 'GET') {
        let query = 'SELECT * FROM classes';
        const params = [];
        if (tenantId) { query += ' WHERE tenant_id = ?'; params.push(tenantId); }
        query += ' ORDER BY name';
        const classes = await env.DB.prepare(query).bind(...params).all();
        return jsonResponse({ success: true, data: nullToEmpty(classes.results) });
      }

      if (path === '/api/classes' && method === 'POST') {
        const body = await request.json();
        const id = generateId();
        try {
          await env.DB.prepare(
            'INSERT INTO classes (id, tenant_id, name, level, department, academic_year, capacity, schedule, teacher_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, tenantId, body.name ?? '', body.level ?? null, body.department ?? null, body.academic_year ?? null, body.capacity ?? 30, body.schedule ?? null, body.teacher_id ?? null).run();
        } catch(e) {
          await env.DB.prepare(
            'INSERT INTO classes (id, name, level, department, academic_year, capacity, schedule, teacher_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, body.name ?? '', body.level ?? null, body.department ?? null, body.academic_year ?? null, body.capacity ?? 30, body.schedule ?? null, body.teacher_id ?? null).run();
        }
        return jsonResponse({ success: true, data: { id, ...body } }, 201);
      }

      if (path.match(/^\/api\/classes\/[^/]+$/) && method === 'PUT') {
        const id = path.split('/').pop();
        const body = await request.json();
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(body)) {
          if (['name', 'level', 'department', 'academic_year', 'capacity', 'schedule', 'teacher_id'].includes(k)) {
            sets.push(`${k} = ?`);
            vals.push(v === undefined ? null : v);
          }
        }
        if (sets.length === 0) return errorResponse('No valid fields to update');
        sets.push('updated_at = datetime("now")');
        vals.push(id);
        await env.DB.prepare(`UPDATE classes SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return jsonResponse({ success: true });
      }

      if (path.match(/^\/api\/classes\/[^/]+$/) && method === 'DELETE') {
        if (session.role !== 'admin') return errorResponse('Forbidden', 403);
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM classes WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
      }

      // ==================== MODULES ====================
      if (path === '/api/modules' && method === 'GET') {
        let query = 'SELECT * FROM modules';
        const params = [];
        if (tenantId) { query += ' WHERE tenant_id = ?'; params.push(tenantId); }
        query += ' ORDER BY name';
        const modules = await env.DB.prepare(query).bind(...params).all();
        return jsonResponse({ success: true, data: nullToEmpty(modules.results) });
      }

      if (path === '/api/modules' && method === 'POST') {
        const body = await request.json();
        const id = generateId();
        try {
          await env.DB.prepare(
            'INSERT INTO modules (id, tenant_id, name, code, class_id, teacher_id, schedule, hours, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, tenantId, body.name ?? '', body.code ?? null, body.class_id ?? null, body.teacher_id ?? null, body.schedule ?? null, body.hours ?? 0, body.description ?? null).run();
        } catch(e) {
          await env.DB.prepare(
            'INSERT INTO modules (id, name, code, class_id, teacher_id, schedule, hours, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, body.name ?? '', body.code ?? null, body.class_id ?? null, body.teacher_id ?? null, body.schedule ?? null, body.hours ?? 0, body.description ?? null).run();
        }
        return jsonResponse({ success: true, data: { id, ...body } }, 201);
      }

      if (path.match(/^\/api\/modules\/[^/]+$/) && method === 'PUT') {
        const id = path.split('/').pop();
        const body = await request.json();
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(body)) {
          if (['name', 'code', 'class_id', 'teacher_id', 'schedule', 'hours', 'description'].includes(k)) {
            sets.push(`${k} = ?`);
            vals.push(v === undefined ? null : v);
          }
        }
        if (sets.length === 0) return errorResponse('No valid fields to update');
        sets.push('updated_at = datetime("now")');
        vals.push(id);
        await env.DB.prepare(`UPDATE modules SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return jsonResponse({ success: true });
      }

      if (path.match(/^\/api\/modules\/[^/]+$/) && method === 'DELETE') {
        if (session.role !== 'admin') return errorResponse('Forbidden', 403);
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM modules WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
      }

      // ==================== TASKS ====================
      if (path === '/api/tasks' && method === 'GET') {
        const statusFilter = url.searchParams.get('status');
        const assignedTo = url.searchParams.get('assigned_to');
        let query = 'SELECT t.*, u1.full_name as assigned_to_name, u2.full_name as assigned_by_name FROM tasks t LEFT JOIN users u1 ON t.assigned_to = u1.id LEFT JOIN users u2 ON t.assigned_by = u2.id WHERE 1=1';
        const params = [];
        if (tenantId) { query += ' AND t.tenant_id = ?'; params.push(tenantId); }
        if (statusFilter) { query += ' AND t.status = ?'; params.push(statusFilter); }
        if (assignedTo) { query += ' AND t.assigned_to = ?'; params.push(assignedTo); }
        query += ' ORDER BY t.created_at DESC';
        const tasks = await env.DB.prepare(query).bind(...params).all();
        return jsonResponse({ success: true, data: nullToEmpty(tasks.results) });
      }

      if (path === '/api/tasks' && method === 'POST') {
        const body = await request.json();
        const id = generateId();
        try {
          await env.DB.prepare(
            'INSERT INTO tasks (id, tenant_id, title, description, assigned_to, assigned_by, priority, status, category, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, tenantId, body.title ?? '', body.description ?? null, body.assigned_to ?? '', session.user_id, body.priority ?? 'medium', body.status ?? 'pending', body.category ?? null, body.due_date ?? null).run();
        } catch(e) {
          await env.DB.prepare(
            'INSERT INTO tasks (id, title, description, assigned_to, assigned_by, priority, status, category, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, body.title ?? '', body.description ?? null, body.assigned_to ?? '', session.user_id, body.priority ?? 'medium', body.status ?? 'pending', body.category ?? null, body.due_date ?? null).run();
        }
        return jsonResponse({ success: true, data: { id, ...body } }, 201);
      }

      if (path.match(/^\/api\/tasks\/[^/]+$/) && method === 'PUT') {
        const id = path.split('/').pop();
        const body = await request.json();
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(body)) {
          if (['title', 'description', 'assigned_to', 'priority', 'status', 'category', 'due_date', 'completed_date', 'completion_report'].includes(k)) {
            sets.push(`${k} = ?`);
            vals.push(v === undefined ? null : v);
          }
        }
        if (sets.length === 0) return errorResponse('No valid fields to update');
        sets.push('updated_at = datetime("now")');
        vals.push(id);
        await env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return jsonResponse({ success: true });
      }

      if (path.match(/^\/api\/tasks\/[^/]+$/) && method === 'DELETE') {
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
        try { await env.DB.prepare('DELETE FROM task_files WHERE task_id = ?').bind(id).run(); } catch(e) {}
        try { await env.DB.prepare('DELETE FROM task_comments WHERE task_id = ?').bind(id).run(); } catch(e) {}
        return jsonResponse({ success: true });
      }

      // Task files
      if (path === '/api/tasks/files' && method === 'GET') {
        const taskId = url.searchParams.get('task_id');
        if (!taskId) return errorResponse('task_id required');
        const files = await env.DB.prepare('SELECT id, task_id, filename, file_type, file_size, uploaded_by, created_at FROM task_files WHERE task_id = ?').bind(taskId).all();
        return jsonResponse({ success: true, data: nullToEmpty(files.results) });
      }

      if (path === '/api/tasks/files' && method === 'POST') {
        const body = await request.json();
        const id = generateId();
        await env.DB.prepare(
          'INSERT INTO task_files (id, task_id, filename, file_type, file_size, file_data, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, body.task_id, body.filename, body.file_type || null, body.file_size || 0, body.file_data || null, session.user_id).run();
        return jsonResponse({ success: true, data: { id } }, 201);
      }

      if (path.match(/^\/api\/tasks\/files\/[^/]+$/) && method === 'GET') {
        const id = path.split('/').pop();
        const file = await env.DB.prepare('SELECT * FROM task_files WHERE id = ?').bind(id).first();
        if (!file) return errorResponse('File not found', 404);
        return jsonResponse({ success: true, data: nullToEmpty(file) });
      }

      if (path.match(/^\/api\/tasks\/files\/[^/]+$/) && method === 'DELETE') {
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM task_files WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
      }

      // Task comments
      if (path === '/api/tasks/comments' && method === 'GET') {
        const taskId = url.searchParams.get('task_id');
        if (!taskId) return errorResponse('task_id required');
        const comments = await env.DB.prepare('SELECT tc.*, u.full_name as user_name FROM task_comments tc LEFT JOIN users u ON tc.user_id = u.id WHERE tc.task_id = ? ORDER BY tc.created_at').bind(taskId).all();
        return jsonResponse({ success: true, data: nullToEmpty(comments.results) });
      }

      if (path === '/api/tasks/comments' && method === 'POST') {
        const body = await request.json();
        const id = generateId();
        await env.DB.prepare('INSERT INTO task_comments (id, task_id, user_id, comment) VALUES (?, ?, ?, ?)')
          .bind(id, body.task_id, session.user_id, body.comment).run();
        return jsonResponse({ success: true, data: { id } }, 201);
      }

      // ==================== INCIDENTS ====================
      if (path === '/api/incidents' && method === 'GET') {
        const statusFilter = url.searchParams.get('status');
        const studentId = url.searchParams.get('student_id');
        let query = 'SELECT i.*, s.first_name, s.last_name, u.full_name as reporter_name FROM incidents i LEFT JOIN students s ON i.student_id = s.id LEFT JOIN users u ON i.reported_by = u.id WHERE 1=1';
        const params = [];
        if (tenantId) { query += ' AND i.tenant_id = ?'; params.push(tenantId); }
        if (statusFilter) { query += ' AND i.status = ?'; params.push(statusFilter); }
        if (studentId) { query += ' AND i.student_id = ?'; params.push(studentId); }
        query += ' ORDER BY i.created_at DESC';
        const incidents = await env.DB.prepare(query).bind(...params).all();
        return jsonResponse({ success: true, data: nullToEmpty(incidents.results) });
      }

      if (path === '/api/incidents' && method === 'POST') {
        const body = await request.json();
        const id = generateId();
        try {
          await env.DB.prepare(
            'INSERT INTO incidents (id, tenant_id, student_id, reported_by, type, severity, description, action_taken, status, incident_date, location, witnesses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, tenantId, body.student_id ?? '', session.user_id, body.type ?? '', body.severity ?? 'medium', body.description ?? '', body.action_taken ?? null, body.status ?? 'open', body.incident_date ?? null, body.location ?? null, body.witnesses ?? null).run();
        } catch(e) {
          await env.DB.prepare(
            'INSERT INTO incidents (id, student_id, reported_by, type, severity, description, action_taken, status, incident_date, location, witnesses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, body.student_id ?? '', session.user_id, body.type ?? '', body.severity ?? 'medium', body.description ?? '', body.action_taken ?? null, body.status ?? 'open', body.incident_date ?? null, body.location ?? null, body.witnesses ?? null).run();
        }
        return jsonResponse({ success: true, data: { id, ...body } }, 201);
      }

      if (path.match(/^\/api\/incidents\/[^/]+$/) && method === 'PUT') {
        const id = path.split('/').pop();
        const body = await request.json();
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(body)) {
          if (['type', 'severity', 'description', 'action_taken', 'status', 'incident_date', 'location', 'witnesses', 'follow_up_notes', 'resolution_date'].includes(k)) {
            sets.push(`${k} = ?`);
            vals.push(v === undefined ? null : v);
          }
        }
        if (sets.length === 0) return errorResponse('No valid fields to update');
        sets.push('updated_at = datetime("now")');
        vals.push(id);
        await env.DB.prepare(`UPDATE incidents SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return jsonResponse({ success: true });
      }

      if (path.match(/^\/api\/incidents\/[^/]+$/) && method === 'DELETE') {
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM incidents WHERE id = ?').bind(id).run();
        try { await env.DB.prepare('DELETE FROM incident_files WHERE incident_id = ?').bind(id).run(); } catch(e) {}
        return jsonResponse({ success: true });
      }

      // Incident files
      if (path === '/api/incidents/files' && method === 'GET') {
        const incidentId = url.searchParams.get('incident_id');
        if (!incidentId) return errorResponse('incident_id required');
        const files = await env.DB.prepare('SELECT id, incident_id, filename, file_type, file_size, uploaded_by, created_at FROM incident_files WHERE incident_id = ?').bind(incidentId).all();
        return jsonResponse({ success: true, data: nullToEmpty(files.results) });
      }

      if (path === '/api/incidents/files' && method === 'POST') {
        const body = await request.json();
        const id = generateId();
        await env.DB.prepare(
          'INSERT INTO incident_files (id, incident_id, filename, file_type, file_size, file_data, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, body.incident_id, body.filename, body.file_type || null, body.file_size || 0, body.file_data || null, session.user_id).run();
        return jsonResponse({ success: true, data: { id } }, 201);
      }

      if (path.match(/^\/api\/incidents\/files\/[^/]+$/) && method === 'GET') {
        const id = path.split('/').pop();
        const file = await env.DB.prepare('SELECT * FROM incident_files WHERE id = ?').bind(id).first();
        if (!file) return errorResponse('File not found', 404);
        return jsonResponse({ success: true, data: nullToEmpty(file) });
      }

      if (path.match(/^\/api\/incidents\/files\/[^/]+$/) && method === 'DELETE') {
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM incident_files WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
      }

      // ==================== SETTINGS ====================
      if (path === '/api/settings' && method === 'GET') {
        let query = 'SELECT * FROM settings';
        const params = [];
        if (tenantId) { query += ' WHERE tenant_id = ?'; params.push(tenantId); }
        const settings = await env.DB.prepare(query).bind(...params).all();
        const result = {};
        for (const s of settings.results) {
          try { result[s.key] = JSON.parse(s.value); } catch { result[s.key] = s.value; }
        }
        return jsonResponse({ success: true, data: result });
      }

      if (path === '/api/settings' && method === 'PUT') {
        const body = await request.json();
        for (const [k, v] of Object.entries(body)) {
          const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
          try {
            await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, tenant_id, updated_at) VALUES (?, ?, ?, datetime("now"))').bind(k, val, tenantId).run();
          } catch(e) {
            await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now"))').bind(k, val).run();
          }
        }
        return jsonResponse({ success: true });
      }

      // ==================== DASHBOARD STATS ====================
      if (path === '/api/stats' && method === 'GET') {
        let tq = tenantId ? 'WHERE tenant_id = ?' : '';
        const tp = tenantId ? [tenantId] : [];
        const totalStudents = await env.DB.prepare(`SELECT COUNT(*) as count FROM students ${tq}`).bind(...tp).first();
        const totalClasses = await env.DB.prepare(`SELECT COUNT(*) as count FROM classes ${tq}`).bind(...tp).first();
        const todayAttendance = await env.DB.prepare(`SELECT COUNT(*) as count FROM attendance WHERE date = date('now') ${tenantId ? 'AND tenant_id = ?' : ''}`).bind(...tp).first();
        const presentToday = await env.DB.prepare(`SELECT COUNT(*) as count FROM attendance WHERE date = date('now') AND status = 'present' ${tenantId ? 'AND tenant_id = ?' : ''}`).bind(...tp).first();
        const totalTasks = await env.DB.prepare(`SELECT COUNT(*) as count FROM tasks ${tq}`).bind(...tp).first();
        const pendingTasks = await env.DB.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'in-progress') ${tenantId ? 'AND tenant_id = ?' : ''}`).bind(...tp).first();
        const openIncidents = await env.DB.prepare(`SELECT COUNT(*) as count FROM incidents WHERE status IN ('open', 'investigating') ${tenantId ? 'AND tenant_id = ?' : ''}`).bind(...tp).first();
        const totalUsers = await env.DB.prepare(`SELECT COUNT(*) as count FROM users WHERE is_active = 1 ${tenantId ? 'AND tenant_id = ?' : ''}`).bind(...tp).first();

        return jsonResponse({
          success: true,
          data: {
            totalStudents: totalStudents.count, totalClasses: totalClasses.count,
            todayAttendance: todayAttendance.count, presentToday: presentToday.count,
            totalTasks: totalTasks.count, pendingTasks: pendingTasks.count,
            openIncidents: openIncidents.count, totalUsers: totalUsers.count
          }
        });
      }

      // ==================== DATA EXPORT/IMPORT ====================
      if (path === '/api/export' && method === 'GET') {
        const tq = tenantId ? 'WHERE tenant_id = ?' : '';
        const tp = tenantId ? [tenantId] : [];
        const students = await env.DB.prepare(`SELECT * FROM students ${tq}`).bind(...tp).all();
        const attendance = await env.DB.prepare(`SELECT * FROM attendance ${tq}`).bind(...tp).all();
        const classes = await env.DB.prepare(`SELECT * FROM classes ${tq}`).bind(...tp).all();
        const modules = await env.DB.prepare(`SELECT * FROM modules ${tq}`).bind(...tp).all();
        const tasks = await env.DB.prepare(`SELECT * FROM tasks ${tq}`).bind(...tp).all();
        const incidents = await env.DB.prepare(`SELECT * FROM incidents ${tq}`).bind(...tp).all();
        const settings = await env.DB.prepare(`SELECT * FROM settings ${tq}`).bind(...tp).all();
        const users = await env.DB.prepare(`SELECT id, username, role, full_name, email, phone, department, is_active FROM users ${tq}`).bind(...tp).all();

        return jsonResponse({
          success: true,
          data: {
            students: nullToEmpty(students.results), attendance: nullToEmpty(attendance.results),
            classes: nullToEmpty(classes.results), modules: nullToEmpty(modules.results),
            tasks: nullToEmpty(tasks.results), incidents: nullToEmpty(incidents.results),
            settings: settings.results, users: nullToEmpty(users.results),
            exportedAt: new Date().toISOString()
          }
        });
      }

      if (path === '/api/import' && method === 'POST') {
        if (session.role !== 'admin') return errorResponse('Forbidden', 403);
        const body = await request.json();
        let imported = 0;
        if (body.students && Array.isArray(body.students)) {
          for (const s of body.students) {
            await env.DB.prepare(
              'INSERT OR REPLACE INTO students (id, first_name, last_name, email, phone, class, group_name, academic_year, status, photo, enrollment_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(s.id || generateId(), s.first_name, s.last_name, s.email, s.phone, s.class, s.group_name, s.academic_year, s.status || 'active', s.photo, s.enrollment_date, s.notes).run();
            imported++;
          }
        }
        if (body.attendance && Array.isArray(body.attendance)) {
          for (const a of body.attendance) {
            await env.DB.prepare(
              'INSERT OR REPLACE INTO attendance (id, student_id, date, status, class, module, notes, marked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(a.id || generateId(), a.student_id, a.date, a.status, a.class, a.module, a.notes, a.marked_by).run();
            imported++;
          }
        }
        return jsonResponse({ success: true, data: { imported } });
      }

      // ==================== DATABASE MIGRATION ====================
      if (path === '/api/migrate' && method === 'POST') {
        if (session.role !== 'admin') return errorResponse('Forbidden', 403);
        const migrations = [
          'ALTER TABLE students ADD COLUMN guardian_name TEXT',
          'ALTER TABLE students ADD COLUMN guardian_phone TEXT',
          'ALTER TABLE students ADD COLUMN student_id TEXT',
          'ALTER TABLE students ADD COLUMN address TEXT'
        ];
        const results = [];
        for (const sql of migrations) {
          try {
            await env.DB.prepare(sql).run();
            results.push({ sql, status: 'success' });
          } catch (e) {
            results.push({ sql, status: 'skipped', reason: e.message });
          }
        }
        return jsonResponse({ success: true, data: results });
      }

      // ==================== DATABASE CLEANUP ====================
      if (path === '/api/cleanup' && method === 'POST') {
        if (session.role !== 'admin') return errorResponse('Forbidden', 403);
        try {
          const corrupted = await env.DB.prepare("SELECT id FROM students WHERE COALESCE(first_name, '') = '' OR TRIM(first_name) = ''").all();
          const corruptedIds = corrupted.results.map(s => s.id);
          let deletedAttendance = 0, deletedIncidents = 0, deletedStudents = 0;
          for (const id of corruptedIds) {
            try { const r = await env.DB.prepare('DELETE FROM attendance WHERE student_id = ?').bind(id).run(); deletedAttendance += r.meta?.changes || 0; } catch(e) {}
            try { const r = await env.DB.prepare('DELETE FROM incidents WHERE student_id = ?').bind(id).run(); deletedIncidents += r.meta?.changes || 0; } catch(e) {}
          }
          const result = await env.DB.prepare("DELETE FROM students WHERE COALESCE(first_name, '') = '' OR TRIM(first_name) = ''").run();
          deletedStudents = result.meta?.changes || 0;
          return jsonResponse({ success: true, message: 'Cleanup completed', deletedStudents, deletedAttendance, deletedIncidents });
        } catch (e) {
          return errorResponse('Cleanup failed: ' + e.message, 500);
        }
      }

      // ==================== CURRENT USER ====================
      if (path === '/api/me' && method === 'GET') {
        const user = await env.DB.prepare('SELECT id, username, role, full_name, email, phone, photo, department, tenant_id, is_super_admin FROM users WHERE id = ?').bind(session.user_id).first();
        return jsonResponse({ success: true, data: nullToEmpty(user) });
      }

      // 404 fallback
      return errorResponse('Not found', 404);

    } catch (e) {
      console.error('API Error:', e);
      return errorResponse('Internal server error: ' + e.message, 500);
    }
  }
};
