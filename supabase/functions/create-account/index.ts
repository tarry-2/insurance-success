// 인슈런스 석세스 — 관리자 계정 발급 Edge Function
// 관리자(지점장/팀장, 또는 개발자코드)가 만든 계정이 "실제 로그인 가능한 계정"이 되도록
// service_role 로 auth.users 생성 + profiles insert 한다. (프론트엔 service_role 을 절대 두지 않음)
//
// 인증 2경로:
//   1) Authorization: Bearer <JWT>  → 요청자 profile.role 로 위계 스코프 강제
//      - hq     : 아무 역할/지점/팀 생성
//      - branch : team|agent 만, 본인 지점(branch_id) 안에서만
//      - team   : agent 만, 본인 팀(team_id) 안에서만
//      - agent  : 거부
//   2) body.devCode === env DEV_CODE  → hq 전권(개발자 콘솔용 백도어)
//
// 요청 body: { name, phone, pw, role, branchId?, teamId?, devCode? }
// 응답     : { ok:true, user:{id,name,phone,role,branchId,teamId,code}, tempPassword } | { error }
//
// 배포: supabase functions deploy create-account --no-verify-jwt --project-ref lfpfofwlesfriegkwold
//   (--no-verify-jwt: 플랫폼 JWT 게이트를 끄고 함수 내부에서 직접 검증. devCode 경로를 위해 필요)
//   env(DEV_CODE)는 대시보드 Edge Functions → Secrets 또는 supabase secrets set 로 설정.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const DEV_CODE = Deno.env.get('DEV_CODE') || '413601';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const phoneEmail = (p: string) => String(p).replace(/\D/g, '') + '@insu.app';
const normPhone = (p: string) => String(p).replace(/\D/g, '');
const rid = (p: string) => p + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: '잘못된 요청' }, 400); }

  const { name, phone, pw, role } = body || {};
  if (!name || !phone || !pw) return json({ error: '이름·전화번호·비밀번호는 필수입니다' }, 400);
  if (String(pw).length < 6) return json({ error: '비밀번호는 6자 이상' }, 400);
  if (normPhone(phone).length < 10) return json({ error: '전화번호를 확인하세요' }, 400);
  if (!['branch', 'team', 'agent'].includes(role)) return json({ error: '역할이 올바르지 않습니다' }, 400);

  const svc = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ── 요청자 판별 & 권한 스코프 결정 ──
  let requester: { role: string; branchId: string | null; teamId: string | null } | null = null;
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (body.devCode && body.devCode === DEV_CODE) {
    requester = { role: 'hq', branchId: null, teamId: null };           // 개발자 백도어 = hq 전권
  } else if (token && token !== ANON_KEY) {
    const anon = createClient(SB_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
    const { data: ures, error: uerr } = await anon.auth.getUser();
    if (uerr || !ures?.user) return json({ error: '로그인이 필요합니다' }, 401);
    const { data: prof } = await svc.from('profiles').select('role,branch_id,team_id').eq('id', ures.user.id).maybeSingle();
    if (!prof) return json({ error: '요청자 프로필을 찾을 수 없습니다' }, 403);
    requester = { role: prof.role, branchId: prof.branch_id, teamId: prof.team_id };
  } else {
    return json({ error: '권한이 없습니다(인증 필요)' }, 401);
  }

  // ── 위계 스코프 강제 ──
  let branchId: string | null = body.branchId || null;
  let teamId: string | null = body.teamId || null;
  if (requester.role === 'hq') {
    // 자유. 값 그대로.
  } else if (requester.role === 'branch') {
    if (!['team', 'agent'].includes(role)) return json({ error: '지점장은 팀장·설계사만 생성할 수 있습니다' }, 403);
    branchId = requester.branchId;                                       // 본인 지점 강제
  } else if (requester.role === 'team') {
    if (role !== 'agent') return json({ error: '팀장은 설계사만 생성할 수 있습니다' }, 403);
    branchId = requester.branchId;
    teamId = requester.teamId;                                           // 본인 팀 강제
  } else {
    return json({ error: '계정 생성 권한이 없습니다' }, 403);
  }

  // ── 전화번호 중복 체크 ──
  const nphone = normPhone(phone);
  const { data: dup } = await svc.from('profiles').select('id').eq('phone', nphone).maybeSingle();
  if (dup) return json({ error: '이미 가입된 전화번호입니다' }, 409);

  // ── auth.users 생성(이메일 확인 skip = 즉시 로그인 가능) ──
  const { data: created, error: cerr } = await svc.auth.admin.createUser({
    email: phoneEmail(phone),
    password: String(pw),
    email_confirm: true,
    user_metadata: { name, phone: nphone, role },
  });
  if (cerr || !created?.user) {
    const msg = cerr?.message || '';
    if (/registered|exists|already/i.test(msg)) return json({ error: '이미 가입된 전화번호입니다' }, 409);
    return json({ error: '계정 생성 실패: ' + msg }, 500);
  }
  const uid = created.user.id;

  // ── 지점장/팀장이면 조직 코드 발급 + 조직 리더 연결 ──
  const code = role === 'branch' ? rid('GN') : role === 'team' ? rid('TM') : null;
  const grade = role === 'branch' ? 'PLAT' : role === 'team' ? 'GOLD' : 'FC';
  const goalApe = role === 'agent' ? 200 : 300;

  const { error: perr } = await svc.from('profiles').insert({
    id: uid, name, phone: nphone, role,
    branch_id: branchId, team_id: teamId,
    recruiter_id: null, code, grade, goal_ape: goalApe,
    consent: { tos: true, privacy: true, at: Date.now(), by: 'admin' },
  });
  if (perr) {
    await svc.auth.admin.deleteUser(uid).catch(() => {});               // 롤백: 프로필 실패 시 auth 계정도 제거
    return json({ error: '프로필 생성 실패: ' + perr.message }, 500);
  }

  // 조직 리더 연결(있을 때만)
  if (role === 'team' && teamId) await svc.from('teams').update({ leader_id: uid }).eq('id', teamId);
  if (role === 'branch' && branchId) await svc.from('branches').update({ manager_id: uid }).eq('id', branchId);

  return json({
    ok: true,
    user: { id: uid, name, phone: nphone, role, branchId, teamId, code, grade, goalApe },
    tempPassword: String(pw),
  });
});
