// INFOHAS Attendance System - Cloudflare Worker API
// D1 Database Backend

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

// Simple auth check - in production you'd use JWT or similar
async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7);
  try {
    const session = await env.DB.prepare('SELECT s.*, u.username, u.role, u.full_name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND expires_at > datetime("now")').bind(token).first();
    return session;
  } catch (e) {
    return null;
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
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // ==================== AUTH ROUTES (no auth required) ====================
    if (path === '/api/auth/login' && method === 'POST') {
      try {
        const { username, password } = await request.json();
        if (!username || !password) return errorResponse('Username and password required');

        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').bind(username).first();
        if (!user) return errorResponse('Invalid credentials', 401);
        if (user.password !== password) return errorResponse('Invalid credentials', 401);

        // Create session token
        const token = generateId() + generateId();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)')
          .bind(generateId(), user.id, token, expiresAt).run();

        return jsonResponse({
          success: true,
          token,
          user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name, email: user.email, photo: user.photo }
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

    // Change Password - requires authentication
    if (path === '/api/auth/change-password' && method === 'POST') {
      const session = await authenticate(request, env);
      if (!session) {
        return errorResponse('Unauthorized', 401);
      }
      try {
        const { currentPassword, newPassword } = await request.json();
        if (!currentPassword || !newPassword) {
          return errorResponse('Current password and new password are required');
        }
        if (newPassword.length < 4) {
          return errorResponse('New password must be at least 4 characters');
        }

        // Verify current password
        const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
        if (!user || user.password !== currentPassword) {
          return errorResponse('Current password is incorrect', 401);
        }

        // Update password in database
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

    try {
      // ==================== USERS ====================
      if (path === '/api/users' && method === 'GET') {
        const users = await env.DB.prepare('SELECT id, username, role, full_name, email, phone, photo, department, is_active, created_at, updated_at FROM users').all();
        return jsonResponse({ success: true, data: nullToEmpty(users.results) });
      }

      if (path === '/api/users' && method === 'POST') {
        if (session.role !== 'admin') return errorResponse('Forbidden', 403);
        const body = await request.json();
        const id = generateId();
        await env.DB.prepare(
          'INSERT INTO users (id, username, password, role, full_name, email, phone, photo, department) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, body.username, body.password || 'employee123', body.role || 'employee', body.full_name, body.email || null, body.phone || null, body.photo || null, body.department || null).run();
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
        const students = await env.DB.prepare('SELECT * FROM students ORDER BY created_at DESC').all();
        // Filter out corrupted records (empty first_name) and normalize nulls to empty strings
        const validStudents = students.results
          .filter(s => (s.first_name || '').trim() !== '')
          .map(nullToEmpty);
        return jsonResponse({ success: true, data: validStudents });
      }

      if (path === '/api/students' && method === 'POST') {
        const body = await request.json();
        const id = body.id || generateId();
        // Use provided student_id or generate one
        const studentId = body.student_id || body.studentId || id.substring(0, 8).toUpperCase();
        // Ensure all values are null-safe (D1 doesn't accept undefined)
        // Use empty string for NOT NULL fields, null for nullable fields
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
        // Try to add with guardian columns
        try {
          await env.DB.prepare(
            'INSERT INTO students (id, first_name, last_name, email, phone, class, group_name, academic_year, status, photo, enrollment_date, notes, guardian_name, guardian_phone, student_id, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, firstName, lastName, email, phone, className, groupName, academicYear, status, photo, enrollmentDate, notes, guardianName, guardianPhone, studentId, address).run();
        } catch (e) {
          // Fallback if guardian columns don't exist yet
          await env.DB.prepare(
            'INSERT INTO students (id, first_name, last_name, email, phone, class, group_name, academic_year, status, photo, enrollment_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, firstName, lastName, email, phone, className, groupName, academicYear, status, photo, enrollmentDate, notes).run();
        }
        return jsonResponse({ success: true, data: { id, ...body } }, 201);
      }

      if (path === '/api/students/batch-assign-class' && method === 'POST') {
        const body = await request.json();
        const { studentIds, classId } = body;
        if (!Array.isArray(studentIds) || studentIds.length === 0) {
          return errorResponse('studentIds array is required');
        }
        if (!classId) {
          return errorResponse('classId is required');
        }
        // Verify class exists
        const classExists = await env.DB.prepare('SELECT id FROM classes WHERE id = ?').bind(classId).first();
        if (!classExists) {
          return errorResponse('Class not found', 404);
        }
        let updated = 0;
        for (const studentId of studentIds) {
          await env.DB.prepare('UPDATE students SET class = ?, group_name = ?, updated_at = datetime("now") WHERE id = ?')
            .bind(classId, classId, studentId).run();
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
        // Delete dependent records first to avoid foreign key constraint errors
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
        if (date) { query += ' AND a.date = ?'; params.push(date); }
        if (classFilter) { query += ' AND a.class = ?'; params.push(classFilter); }
        query += ' ORDER BY a.date DESC';
        const attendance = await env.DB.prepare(query).bind(...params).all();
        return jsonResponse({ success: true, data: nullToEmpty(attendance.results) });
      }

      if (path === '/api/attendance' && method === 'POST') {
        const body = await request.json();
        // Support batch insert
        if (Array.isArray(body)) {
          const results = [];
          for (const record of body) {
            const id = generateId();
            await env.DB.prepare(
              'INSERT OR REPLACE INTO attendance (id, student_id, date, status, class, module, notes, marked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(id, record.student_id, record.date, record.status, record.class || null, record.module || null, record.notes || null, session.user_id).run();
            results.push(id);
          }
          return jsonResponse({ success: true, data: { count: results.length } }, 201);
        } else {
          const id = generateId();
          await env.DB.prepare(
            'INSERT OR REPLACE INTO attendance (id, student_id, date, status, class, module, notes, marked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, body.student_id, body.date, body.status, body.class || null, body.module || null, body.notes || null, session.user_id).run();
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
        const classes = await env.DB.prepare('SELECT * FROM classes ORDER BY name').all();
        return jsonResponse({ success: true, data: nullToEmpty(classes.results) });
      }

      if (path === '/api/classes' && method === 'POST') {
        const body = await request.json();
        const id = generateId();
        await env.DB.prepare(
          'INSERT INTO classes (id, name, level, department, academic_year, capacity, schedule, teacher_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, body.name ?? '', body.level ?? null, body.department ?? null, body.academic_year ?? null, body.capacity ?? 30, body.schedule ?? null, body.teacher_id ?? null).run();
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
        const modules = await env.DB.prepare('SELECT * FROM modules ORDER BY name').all();
        return jsonResponse({ success: true, data: nullToEmpty(modules.results) });
      }

      if (path === '/api/modules' && method === 'POST') {
        const body = await request.json();
        const id = generateId();
        await env.DB.prepare(
          'INSERT INTO modules (id, name, code, class_id, teacher_id, schedule, hours, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, body.name ?? '', body.code ?? null, body.class_id ?? null, body.teacher_id ?? null, body.schedule ?? null, body.hours ?? 0, body.description ?? null).run();
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
        const status = url.searchParams.get('status');
        const assignedTo = url.searchParams.get('assigned_to');
        let query = 'SELECT t.*, u1.full_name as assigned_to_name, u2.full_name as assigned_by_name FROM tasks t LEFT JOIN users u1 ON t.assigned_to = u1.id LEFT JOIN users u2 ON t.assigned_by = u2.id WHERE 1=1';
        const params = [];
        if (status) { query += ' AND t.status = ?'; params.push(status); }
        if (assignedTo) { query += ' AND t.assigned_to = ?'; params.push(assignedTo); }
        query += ' ORDER BY t.created_at DESC';
        const tasks = await env.DB.prepare(query).bind(...params).all();
        return jsonResponse({ success: true, data: nullToEmpty(tasks.results) });
      }

      if (path === '/api/tasks' && method === 'POST') {
        const body = await request.json();
        const id = generateId();
        await env.DB.prepare(
          'INSERT INTO tasks (id, title, description, assigned_to, assigned_by, priority, status, category, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, body.title ?? '', body.description ?? null, body.assigned_to ?? '', session.user_id, body.priority ?? 'medium', body.status ?? 'pending', body.category ?? null, body.due_date ?? null).run();
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
        await env.DB.prepare('DELETE FROM task_files WHERE task_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM task_comments WHERE task_id = ?').bind(id).run();
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
        const status = url.searchParams.get('status');
        const studentId = url.searchParams.get('student_id');
        let query = 'SELECT i.*, s.first_name, s.last_name, u.full_name as reporter_name FROM incidents i LEFT JOIN students s ON i.student_id = s.id LEFT JOIN users u ON i.reported_by = u.id WHERE 1=1';
        const params = [];
        if (status) { query += ' AND i.status = ?'; params.push(status); }
        if (studentId) { query += ' AND i.student_id = ?'; params.push(studentId); }
        query += ' ORDER BY i.created_at DESC';
        const incidents = await env.DB.prepare(query).bind(...params).all();
        return jsonResponse({ success: true, data: nullToEmpty(incidents.results) });
      }

      if (path === '/api/incidents' && method === 'POST') {
        const body = await request.json();
        const id = generateId();
        await env.DB.prepare(
          'INSERT INTO incidents (id, student_id, reported_by, type, severity, description, action_taken, status, incident_date, location, witnesses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, body.student_id ?? '', session.user_id, body.type ?? '', body.severity ?? 'medium', body.description ?? '', body.action_taken ?? null, body.status ?? 'open', body.incident_date ?? null, body.location ?? null, body.witnesses ?? null).run();
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
        await env.DB.prepare('DELETE FROM incident_files WHERE incident_id = ?').bind(id).run();
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
        const settings = await env.DB.prepare('SELECT * FROM settings').all();
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
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now"))').bind(k, val).run();
        }
        return jsonResponse({ success: true });
      }

      // ==================== DASHBOARD STATS ====================
      if (path === '/api/stats' && method === 'GET') {
        const totalStudents = await env.DB.prepare('SELECT COUNT(*) as count FROM students').first();
        const totalClasses = await env.DB.prepare('SELECT COUNT(*) as count FROM classes').first();
        const todayAttendance = await env.DB.prepare("SELECT COUNT(*) as count FROM attendance WHERE date = date('now')").first();
        const presentToday = await env.DB.prepare("SELECT COUNT(*) as count FROM attendance WHERE date = date('now') AND status = 'present'").first();
        const totalTasks = await env.DB.prepare('SELECT COUNT(*) as count FROM tasks').first();
        const pendingTasks = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'in-progress')").first();
        const openIncidents = await env.DB.prepare("SELECT COUNT(*) as count FROM incidents WHERE status IN ('open', 'investigating')").first();
        const totalUsers = await env.DB.prepare('SELECT COUNT(*) as count FROM users WHERE is_active = 1').first();

        return jsonResponse({
          success: true,
          data: {
            totalStudents: totalStudents.count,
            totalClasses: totalClasses.count,
            todayAttendance: todayAttendance.count,
            presentToday: presentToday.count,
            totalTasks: totalTasks.count,
            pendingTasks: pendingTasks.count,
            openIncidents: openIncidents.count,
            totalUsers: totalUsers.count
          }
        });
      }

      // ==================== DATA EXPORT/IMPORT ====================
      if (path === '/api/export' && method === 'GET') {
        const students = await env.DB.prepare('SELECT * FROM students').all();
        const attendance = await env.DB.prepare('SELECT * FROM attendance').all();
        const classes = await env.DB.prepare('SELECT * FROM classes').all();
        const modules = await env.DB.prepare('SELECT * FROM modules').all();
        const tasks = await env.DB.prepare('SELECT * FROM tasks').all();
        const incidents = await env.DB.prepare('SELECT * FROM incidents').all();
        const settings = await env.DB.prepare('SELECT * FROM settings').all();
        const users = await env.DB.prepare('SELECT id, username, role, full_name, email, phone, department, is_active FROM users').all();

        return jsonResponse({
          success: true,
          data: {
            students: nullToEmpty(students.results),
            attendance: nullToEmpty(attendance.results),
            classes: nullToEmpty(classes.results),
            modules: nullToEmpty(modules.results),
            tasks: nullToEmpty(tasks.results),
            incidents: nullToEmpty(incidents.results),
            settings: settings.results,
            users: nullToEmpty(users.results),
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
            // Column likely already exists
            results.push({ sql, status: 'skipped', reason: e.message });
          }
        }
        return jsonResponse({ success: true, data: results });
      }

      // ==================== DATABASE CLEANUP ====================
      if (path === '/api/cleanup' && method === 'POST') {
        if (session.role !== 'admin') return errorResponse('Forbidden', 403);
        try {
          // Get IDs of corrupted students (empty first_name)
          const corrupted = await env.DB.prepare("SELECT id FROM students WHERE COALESCE(first_name, '') = '' OR TRIM(first_name) = ''").all();
          const corruptedIds = corrupted.results.map(s => s.id);
          let deletedAttendance = 0, deletedIncidents = 0, deletedStudents = 0;

          // Delete dependent records first (to avoid foreign key constraint errors)
          for (const id of corruptedIds) {
            try {
              const attRes = await env.DB.prepare('DELETE FROM attendance WHERE student_id = ?').bind(id).run();
              deletedAttendance += attRes.meta?.changes || 0;
            } catch(e) {}
            try {
              const incRes = await env.DB.prepare('DELETE FROM incidents WHERE student_id = ?').bind(id).run();
              deletedIncidents += incRes.meta?.changes || 0;
            } catch(e) {}
          }

          // Now delete the corrupted students
          const result = await env.DB.prepare("DELETE FROM students WHERE COALESCE(first_name, '') = '' OR TRIM(first_name) = ''").run();
          deletedStudents = result.meta?.changes || 0;

          return jsonResponse({
            success: true,
            message: 'Cleanup completed',
            deletedStudents,
            deletedAttendance,
            deletedIncidents
          });
        } catch (e) {
          return errorResponse('Cleanup failed: ' + e.message, 500);
        }
      }

      // ==================== CURRENT USER ====================
      if (path === '/api/me' && method === 'GET') {
        const user = await env.DB.prepare('SELECT id, username, role, full_name, email, phone, photo, department FROM users WHERE id = ?').bind(session.user_id).first();
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
