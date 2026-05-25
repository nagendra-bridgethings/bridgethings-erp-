// Admin — Audit Logs (read-only; writes happen via DB trigger).
//
// Logs are grouped by target_id (e.g. one row per order). Clicking a group
// expands to show every change made to that target chronologically, and
// within each change you can expand to see the field-by-field diff.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../lib/toast';

const fmtDT = d => d ? new Date(d).toLocaleString('en-IN', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
const shortId = id => id ? id.slice(0, 8).toUpperCase() : '';

// Fields that change on every update or are internal metadata — hide from diff.
const IGNORED_DIFF_FIELDS = new Set(['updated_at', 'created_at']);

const formatValue = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const diffRows = (oldRow, newRow) => {
  if (!oldRow || !newRow) return [];
  const allKeys = new Set([...Object.keys(oldRow), ...Object.keys(newRow)]);
  const changes = [];
  for (const key of allKeys) {
    if (IGNORED_DIFF_FIELDS.has(key)) continue;
    const before = oldRow[key];
    const after  = newRow[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ field: key, before, after });
    }
  }
  return changes;
};

const parseSnapshot = (raw) => {
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
};

const LIST_COLUMNS = 'id, timestamp, entity_type, target_id, user_name, user_role, action';

// Entity prefix for the displayed target id (e.g. orders → ORD, products → PRD).
const ENTITY_PREFIX = {
  orders:         'ORD',
  products:       'PRD',
  channelpartners:'CP',
};

const labelForTarget = (entity, targetId) => {
  if (!targetId) return '—';
  const prefix = ENTITY_PREFIX[entity] || entity?.toUpperCase().slice(0, 3) || 'ID';
  return `${prefix}-${shortId(targetId)}`;
};

export default function AuditLogs() {
  const { addToast } = useToast();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  // Which target group (target_id) is currently expanded.
  const [openGroup, setOpenGroup] = useState(null);
  // Which individual log entry inside an expanded group has its diff open.
  const [openLogId, setOpenLogId] = useState(null);
  // Per-log diff cache so re-opening a row doesn't refetch.
  const [detailsCache, setDetailsCache] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('bridgethings_audit_logs')
        .select(LIST_COLUMNS)
        .order('timestamp', { ascending: false })
        .limit(500);
      if (cancelled) return;
      if (error) {
        console.error('[auditLogs] load failed:', error);
        addToast(error.message || 'Failed to load audit logs', 'error');
      } else {
        setLogs(data || []);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [addToast]);

  const fetchDetails = async (logId) => {
    if (detailsCache[logId] && !detailsCache[logId].error) return;
    setDetailsCache(prev => ({ ...prev, [logId]: { loading: true } }));
    const { data, error } = await supabase
      .from('bridgethings_audit_logs')
      .select('old_value, new_value')
      .eq('id', logId)
      .single();
    if (error) {
      console.error('[auditLogs] details failed:', error);
      setDetailsCache(prev => ({ ...prev, [logId]: { loading: false, error } }));
      return;
    }
    const oldRow = parseSnapshot(data.old_value);
    const newRow = parseSnapshot(data.new_value);
    setDetailsCache(prev => ({
      ...prev,
      [logId]: { loading: false, changes: diffRows(oldRow, newRow), newRow },
    }));
  };

  const handleToggleLog = (logId) => {
    if (openLogId === logId) {
      setOpenLogId(null);
      return;
    }
    setOpenLogId(logId);
    fetchDetails(logId);
  };

  const handleToggleGroup = (groupKey) => {
    if (openGroup === groupKey) {
      setOpenGroup(null);
      setOpenLogId(null); // collapse any open diff inside
      return;
    }
    setOpenGroup(groupKey);
    setOpenLogId(null);
  };

  // Apply the entity tab filter, then group logs by target_id.
  const { entityTypes, groups } = useMemo(() => {
    const filtered = filter === 'all' ? logs : logs.filter(l => l.entity_type === filter);

    // Group by `${entity_type}::${target_id}` so the same id under different
    // entities (rare but possible) stays separate.
    const map = new Map();
    for (const log of filtered) {
      const key = `${log.entity_type}::${log.target_id || 'unknown'}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          entity_type: log.entity_type,
          target_id: log.target_id,
          logs: [],
          // Latest timestamp/user for the summary row (logs arrive newest first).
          latestTimestamp: log.timestamp,
          latestUser: log.user_name,
          latestRole: log.user_role,
        });
      }
      map.get(key).logs.push(log);
    }

    return {
      entityTypes: ['all', ...Array.from(new Set(logs.map(l => l.entity_type).filter(Boolean)))],
      groups: Array.from(map.values()),
    };
  }, [logs, filter]);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Audit Logs</div>
          <div className="page-subtitle">One row per record — click to see every change made to it</div>
        </div>
      </div>

      {!loading && logs.length > 0 && (
        <div className="tabs">
          {entityTypes.map(t => (
            <button
              key={t}
              className={`tab${filter === t ? ' active' : ''}`}
              onClick={() => { setFilter(t); setOpenGroup(null); setOpenLogId(null); }}
            >
              {t === 'all' ? 'All' : t} ({t === 'all' ? logs.length : logs.filter(l => l.entity_type === t).length})
            </button>
          ))}
        </div>
      )}

      <div className="card">
        {loading ? (
          <div className="empty-state"><p>Loading audit logs...</p></div>
        ) : groups.length === 0 ? (
          <div className="empty-state">
            <p>{logs.length === 0 ? 'No audit logs found yet. Logs are auto-written by the database when records change.' : 'No logs in this category.'}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Entity</th>
                  <th>Changes</th>
                  <th>Last updated</th>
                  <th>By</th>
                  <th>Role</th>
                  <th style={{width:'6rem'}}></th>
                </tr>
              </thead>
              <tbody>
                {groups.map(group => (
                  <GroupRows
                    key={group.key}
                    group={group}
                    isOpen={openGroup === group.key}
                    onToggle={() => handleToggleGroup(group.key)}
                    openLogId={openLogId}
                    detailsCache={detailsCache}
                    onToggleLog={handleToggleLog}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function GroupRows({ group, isOpen, onToggle, openLogId, detailsCache, onToggleLog }) {
  return (
    <>
      {/* Summary row — one per target */}
      <tr style={{cursor:'pointer'}} onClick={onToggle}>
        <td>
          <span className="font-semibold" style={{color:'var(--primary)'}}>
            {labelForTarget(group.entity_type, group.target_id)}
          </span>
        </td>
        <td><span className="badge badge-info">{group.entity_type}</span></td>
        <td><span className="font-semibold">{group.logs.length}</span></td>
        <td className="text-sm text-muted">{fmtDT(group.latestTimestamp)}</td>
        <td className="text-sm font-semibold">{group.latestUser || '—'}</td>
        <td className="text-sm text-muted">{group.latestRole || '—'}</td>
        <td>
          <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            {isOpen ? 'Hide' : 'Show all'}
          </button>
        </td>
      </tr>

      {/* Expanded: every change to this target, chronological */}
      {isOpen && (
        <tr>
          <td colSpan={7} style={{background:'var(--bg)', padding:'0.75rem 1.25rem'}}>
            <div style={{fontSize:'0.78rem', color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:'0.6rem'}}>
              Change history ({group.logs.length})
            </div>
            <div style={{display:'flex', flexDirection:'column', gap:'0.5rem'}}>
              {group.logs.map((log, idx) => (
                <ChangeEntry
                  key={log.id}
                  log={log}
                  number={group.logs.length - idx}
                  isOpen={openLogId === log.id}
                  details={detailsCache[log.id]}
                  onToggle={() => onToggleLog(log.id)}
                />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ChangeEntry({ log, number, isOpen, details, onToggle }) {
  let label = isOpen ? 'Hide' : 'View';
  if (details?.loading) label = '...';
  else if (details?.changes && details.changes.length === 0) label = 'No changes';

  const disabled = details && !details.loading && details.changes && details.changes.length === 0;

  return (
    <div style={{background:'var(--card)', border:'1px solid var(--border)', borderRadius:'8px', padding:'0.75rem 1rem'}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:'1rem', flexWrap:'wrap'}}>
        <div style={{display:'flex', alignItems:'center', gap:'0.75rem', flexWrap:'wrap'}}>
          <span className="text-xs text-muted" style={{minWidth:'2rem'}}>#{number}</span>
          <span className="text-sm font-semibold">{fmtDT(log.timestamp)}</span>
          <span className="text-sm">{log.action}</span>
          <span className="text-sm text-muted">— {log.user_name || '—'} ({log.user_role || '—'})</span>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onToggle}
          disabled={disabled}
        >
          {label}
        </button>
      </div>

      {isOpen && (
        <div style={{marginTop:'0.75rem'}}>
          {details?.loading || !details ? (
            <div className="text-sm text-muted">Loading changes...</div>
          ) : details.error ? (
            <div className="text-sm" style={{color:'var(--danger)'}}>Failed to load changes.</div>
          ) : details.changes.length === 0 ? (
            <div className="text-sm text-muted">No tracked field changes for this entry.</div>
          ) : (
            <div className="table-wrap">
              <table style={{margin:0}}>
                <thead>
                  <tr>
                    <th style={{width:'20%'}}>Field</th>
                    <th style={{width:'40%'}}>Before</th>
                    <th style={{width:'40%'}}>After</th>
                  </tr>
                </thead>
                <tbody>
                  {details.changes.map(c => (
                    <tr key={c.field}>
                      <td className="text-sm font-semibold">{c.field}</td>
                      <td className="text-sm" style={{color:'var(--danger)', whiteSpace:'pre-wrap', wordBreak:'break-word'}}>
                        {formatValue(c.before)}
                      </td>
                      <td className="text-sm" style={{color:'var(--success)', whiteSpace:'pre-wrap', wordBreak:'break-word'}}>
                        {formatValue(c.after)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
