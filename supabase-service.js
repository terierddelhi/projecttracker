// =====================================================================
// SupaService — Supabase-backed data layer for PowerLens PPM.
//
// Design goal: return data in EXACTLY the shape EmpPortal.data already
// expects (employees[], projects[] with pi/coPi/team/tasks/risks/activity),
// so the existing render functions (renderDashboard, renderProjectsList,
// renderTasksView, etc.) do not need to change — only EmpPortal.load/save
// and Login's auth calls need to be rewired to use this module instead
// of localStorage.
//
// Configure by setting window.SUPABASE_URL and window.SUPABASE_ANON_KEY
// before this script runs (e.g. in a small inline <script> block, or via
// the Settings panel writing to localStorage as user preferences).
// =====================================================================

const SupaService = {
  client: null,
  currentUser: null,   // { email, id, role, name, dept, designation, location } | null

  // -------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------
  init: function () {
    const url = window.SUPABASE_URL || localStorage.getItem('ppm_supabase_url');
    const key = window.SUPABASE_ANON_KEY || localStorage.getItem('ppm_supabase_anon_key');
    if (!url || !key) {
      console.warn('SupaService: Supabase not configured, falling back to local mode.');
      return false;
    }
    this.client = window.supabase.createClient(url, key);
    return true;
  },

  isConfigured: function () {
    return !!this.client;
  },

  // -------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------
  // Checks whether a typed email belongs to a pre-provisioned employee,
  // and whether they've completed first-time signup yet. Returns only
  // a status string for the ONE email provided — never the full
  // directory — so the login page can't be used to enumerate staff.
  // Backed by the is_email_registered() RPC (security definer) in
  // schema.sql; must be granted EXECUTE to the anon role.
  checkRegistrationStatus: async function (email) {
    const { data, error } = await this.client.rpc('check_registration_status', { check_email: email });
    if (error) throw error;
    return data; // 'unknown' | 'new' | 'registered'
  },

  // First-time login: creates the auth user (this also triggers
  // link_profile_on_signup() server-side, which stamps profiles.id).
  signUp: async function (email, password) {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  },

  signIn: async function (email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await this.loadCurrentUser();
    return data;
  },

  signOut: async function () {
    await this.client.auth.signOut();
    this.currentUser = null;
  },

  // Restores session on page load (e.g. after a refresh).
  restoreSession: async function () {
    const { data } = await this.client.auth.getSession();
    if (data && data.session) {
      await this.loadCurrentUser();
      return true;
    }
    return false;
  },

  loadCurrentUser: async function () {
    const { data: authData } = await this.client.auth.getUser();
    if (!authData || !authData.user) { this.currentUser = null; return null; }

    const { data: profile, error } = await this.client
      .from('profiles')
      .select('email, id, name, role, dept, designation, location_id, locations(name)')
      .eq('id', authData.user.id)
      .single();
    if (error) throw error;

    this.currentUser = {
      email: profile.email,
      id: profile.id,
      name: profile.name,
      role: profile.role,           // 'admin' | 'pi' | 'copi' | 'member'
      dept: profile.dept,
      designation: profile.designation,
      location: profile.locations ? profile.locations.name : 'Delhi'
    };
    return this.currentUser;
  },

  // -------------------------------------------------------------
  // Role helpers — mirror what the UI needs to show/hide controls
  // -------------------------------------------------------------
  isAdmin: function () {
    return !!this.currentUser && this.currentUser.role === 'admin';
  },
  canManageProject: function (project) {
    // project here is in EmpPortal's flattened shape (pi/coPi = emails)
    if (!this.currentUser) return false;
    return this.isAdmin()
      || project.pi === this.currentUser.email
      || project.coPi === this.currentUser.email;
  },
  canEditFinancials: function (project) {
    return this.canManageProject(project); // PI/Co-PI/Admin only, same rule
  },
  canUpdateTask: function (task) {
    if (!this.currentUser) return false;
    return this.isAdmin() || task.assignee === this.currentUser.email
      || this._piCoPiCache[task.projectId] === this.currentUser.email;
  },

  // -------------------------------------------------------------
  // Bulk load — returns data in EmpPortal.data's exact shape
  // -------------------------------------------------------------
  loadAllData: async function () {
    const [profilesRes, projectsRes, teamRes, tasksRes, risksRes, activityRes, financialsRes] =
      await Promise.all([
        this.client.from('profiles').select('email, name, dept, designation, role'),
        this.client.from('projects').select('*'),
        this.client.from('project_team').select('*'),
        this.client.from('tasks').select('*'),
        this.client.from('project_risks').select('*'),
        this.client.from('project_activity').select('*').order('ts'),
        this.client.from('financials').select('*'),
      ]);

    [profilesRes, projectsRes, teamRes, tasksRes, risksRes, activityRes, financialsRes]
      .forEach(r => { if (r.error) throw r.error; });

    const employees = profilesRes.data.map(p => ({
      id: p.email,           // EmpPortal keys employees by `id`; we use email as that id
      name: p.name,
      dept: p.dept,
      designation: p.designation,
      role: p.role
    }));

    const teamByProject = {};
    teamRes.data.forEach(row => {
      (teamByProject[row.project_id] = teamByProject[row.project_id] || []).push(row.member_email);
    });

    const tasksByProject = {};
    tasksRes.data.forEach(row => {
      (tasksByProject[row.project_id] = tasksByProject[row.project_id] || []).push({
        id: row.id,
        name: row.name,
        assignee: row.assignee_email,
        dueDate: row.due_date,
        estHours: row.est_hours,
        hoursLogged: row.hours_logged,
        status: row.status,
        progressPct: row.progress_pct
      });
    });

    const risksByProject = {};
    risksRes.data.forEach(row => {
      (risksByProject[row.project_id] = risksByProject[row.project_id] || []).push({
        id: row.id, description: row.description, severity: row.severity, status: row.status
      });
    });

    const activityByProject = {};
    activityRes.data.forEach(row => {
      (activityByProject[row.project_id] = activityByProject[row.project_id] || []).push({
        ts: new Date(row.ts).getTime(), user: row.user_email, action: row.action, comments: row.comments
      });
    });

    const financialsByProject = {};
    financialsRes.data.forEach(row => { financialsByProject[row.project_id] = row; });

    const projects = projectsRes.data.map(p => ({
      id: p.id,
      code: p.code,
      name: p.name,
      pi: p.pi_email,
      coPi: p.co_pi_email,
      team: teamByProject[p.id] || [],
      status: p.status,
      startDate: p.start_date,
      endDate: p.end_date,
      remarks: p.remarks,
      tasks: tasksByProject[p.id] || [],
      risks: risksByProject[p.id] || [],
      activity: activityByProject[p.id] || [],
      financials: financialsByProject[p.id]
        ? {
            contractValue: financialsByProject[p.id].contract_value,
            invoicedTillDate: financialsByProject[p.id].invoiced_till_date,
            collectedTillDate: financialsByProject[p.id].collected_till_date
          }
        : null
    }));

    this._piCoPiCache = {};
    projects.forEach(p => { this._piCoPiCache[p.id] = p.pi; });

    return {
      employees,
      currentEmployeeId: this.currentUser ? this.currentUser.email : (employees[0] && employees[0].id),
      projects,
      notifications: [],   // notifications stay client-side/local for now
      templates: []
    };
  },

  // -------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------
  createProject: async function ({ code, name, startDate, endDate }) {
    const { data, error } = await this.client
      .from('projects')
      .insert({
        code, name,
        pi_email: this.currentUser.email,   // creator becomes PI automatically
        start_date: startDate, end_date: endDate,
        status: 'Not Started'
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  assignTeamMember: async function (projectId, memberEmail, role /* 'Co-PI' | 'Member' */) {
    if (role === 'Co-PI') {
      const { error } = await this.client
        .from('projects').update({ co_pi_email: memberEmail }).eq('id', projectId);
      if (error) throw error;
    } else {
      const { error } = await this.client
        .from('project_team').insert({ project_id: projectId, member_email: memberEmail });
      if (error) throw error;
    }
  },

  createTask: async function ({ projectId, name, assignee, dueDate, estHours }) {
    const { data, error } = await this.client
      .from('tasks')
      .insert({
        project_id: projectId, name,
        assignee_email: assignee, due_date: dueDate, est_hours: estHours,
        status: 'Not Started'
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  // Members (or PI/Co-PI/Admin) submit progress here — never a direct
  // UPDATE on tasks. The DB trigger rolls this up into tasks automatically.
  submitTaskProgress: async function ({ taskId, progressPct, hoursLogged, status, note }) {
    const { error } = await this.client
      .from('task_progress_updates')
      .insert({
        task_id: taskId,
        user_email: this.currentUser.email,
        progress_pct: progressPct,
        hours_logged: hoursLogged,
        status, note
      });
    if (error) throw error;
  },

  upsertFinancials: async function ({ projectId, contractValue, invoicedTillDate, collectedTillDate }) {
    const { error } = await this.client
      .from('financials')
      .upsert({
        project_id: projectId,
        contract_value: contractValue,
        invoiced_till_date: invoicedTillDate,
        collected_till_date: collectedTillDate,
        updated_by: this.currentUser.email,
        updated_at: new Date().toISOString()
      });
    if (error) throw error;   // RLS will reject silently-to-the-UI if not PI/Co-PI/Admin — surface this
  },

  logActivity: async function (projectId, action, comments) {
    const { error } = await this.client
      .from('project_activity')
      .insert({ project_id: projectId, user_email: this.currentUser.email, action, comments });
    if (error) throw error;
  },

  // -------------------------------------------------------------
  // Screen 3 — Resource Card data
  // -------------------------------------------------------------
  getResourceCard: async function (email, month /* 'YYYY-MM' */) {
    const [{ data: profile, error: pErr }, { data: load, error: lErr }, { data: capHours, error: cErr }] =
      await Promise.all([
        this.client.from('profiles').select('name, locations(name)').eq('email', email).single(),
        this.client.from('resource_monthly_load').select('assigned_hours')
          .eq('email', email).eq('month', month).maybeSingle(),
        this.client.rpc('working_hours_for_month', {
          target_month: month,
          emp_location: 'Delhi',   // overwritten below once profile resolves
          hrs_per_day: 8
        })
      ]);
    if (pErr) throw pErr;
    if (lErr) throw lErr;

    const location = profile.locations ? profile.locations.name : 'Delhi';
    const { data: capacity, error: cErr2 } = await this.client.rpc('working_hours_for_month', {
      target_month: month, emp_location: location, hrs_per_day: 8
    });
    if (cErr2) throw cErr2;

    const assigned = (load && load.assigned_hours) || 0;
    const utilizationPct = capacity > 0 ? Math.round((assigned / capacity) * 100) : 0;

    let classification;
    const dailyEquiv = capacity > 0 ? (assigned / capacity) * 8 : 0; // approx hrs/day equivalent
    if (dailyEquiv <= 7) classification = 'Lean';
    else if (dailyEquiv <= 9) classification = 'Healthy';
    else if (dailyEquiv <= 10) classification = 'Busy';
    else classification = 'Overloaded';

    return {
      name: profile.name,
      location,
      month,
      capacityHours: capacity,
      assignedHours: assigned,
      utilizationPct,
      classification
    };
  },

  // -------------------------------------------------------------
  // Admin — Employee Directory (location management only; role
  // changes are intentionally NOT exposed here — those happen only
  // via admin_allowlist in the Supabase SQL editor, per design).
  // -------------------------------------------------------------
  fetchLocations: async function () {
    const { data, error } = await this.client.from('locations').select('id, name').order('name');
    if (error) throw error;
    return data;
  },

  fetchDirectory: async function () {
    const { data, error } = await this.client
      .from('profiles')
      .select('email, name, dept, designation, role, is_registered, location_id, locations(name)')
      .order('name');
    if (error) throw error;
    return data;
  },

  updateEmployeeLocation: async function (email, locationId) {
    // Allowed only because the requester is admin — enforced by
    // block_admin_only_field_changes() in schema.sql, not just here.
    const { error } = await this.client
      .from('profiles')
      .update({ location_id: locationId })
      .eq('email', email);
    if (error) throw error;
  },

  _piCoPiCache: {}
};
