# 계정 발급 Edge Function 배포 (테리용)

조직관리 2단계 = **관리자(지점장/팀장/개발자콘솔)가 만든 계정으로 실제 로그인**을 완성한다.
프론트(app.html)엔 service_role 키를 절대 두지 않는다 → 이 Edge Function이 서버에서 계정을 발급한다.

프로젝트 ref: **lfpfofwlesfriegkwold**

---

## 1. Supabase CLI 설치(한 번만)
```bash
brew install supabase/tap/supabase      # 맥
supabase --version
```

## 2. 로그인 & 프로젝트 연결
```bash
cd ~/Downloads/insurance-success
supabase login                          # 브라우저 토큰 로그인
supabase link --project-ref lfpfofwlesfriegkwold
```

## 3. 시크릿(환경변수) 설정
`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` 는 Supabase가 배포 시 **자동 주입**하므로 설정할 필요 없다.
개발자 백도어 코드만 넣어준다(앱의 DEV_CODE와 동일하게 413601):
```bash
supabase secrets set DEV_CODE=413601 --project-ref lfpfofwlesfriegkwold
```
※ service_role 키는 대시보드 → Settings → API → `service_role secret` 에 있다(절대 프론트/깃에 넣지 말 것).

## 4. 배포
```bash
supabase functions deploy create-account --no-verify-jwt --project-ref lfpfofwlesfriegkwold
```
- `--no-verify-jwt` 필수: 플랫폼 JWT 게이트를 끄고 **함수 내부에서 직접** 토큰/DEV_CODE를 검증한다(개발자 백도어 경로 때문).
- 함수 안에서 위계 스코프를 강제하므로 안전하다(지점장=본인 지점 team/agent만, 팀장=본인 팀 agent만).

## 5. 검증 (배포 후)
```bash
# 개발자코드 경로 — agent 계정 발급 테스트
curl -i -X POST \
  https://lfpfofwlesfriegkwold.supabase.co/functions/v1/create-account \
  -H "Content-Type: application/json" \
  -d '{"name":"테스트설계사","phone":"01099998888","pw":"test1234","role":"agent","devCode":"413601"}'
# → {"ok":true,"user":{...},"tempPassword":"test1234"} 나오면 성공
```
그 다음 앱에서 `01099998888 / test1234` 로 **실제 로그인**되면 완성.

앱 UI로도 확인: 지점장/팀장으로 **실제 로그인**(데모 아님) → 홈 조직탭 → ＋계정 생성 →
"계정 발급 ✓" 토스트 → 새로고침해도 목록에 유지 → 그 번호/비번으로 로그인.

---

## 동작 요약
- **지점장/팀장**: 앱에서 계정 생성 시 로그인 JWT가 자동 첨부 → 서버가 요청자 역할로 스코프 강제.
- **개발자콘솔**: 현재 데모(로컬)모드로 동작 → 로컬 생성만. 실 데이터에 계정 발급이 필요하면
  개발자콘솔을 실 세션으로 붙이거나 위 `devCode` 경로(curl/관리도구)를 쓴다.
- 실패 시 auth 계정을 만들었다가 profiles insert가 실패하면 **자동 롤백**(admin.deleteUser).

파일: `supabase/functions/create-account/index.ts`
