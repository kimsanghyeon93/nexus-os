// NEXUS OS i18n — Korean / English language toggle for every visible
// UI string.
//
// Sprint 5s+ loop iter 10 (operator request: 한영 변경 토글 추가 +
// 모든 글자의 영/한글 매핑 철저하게).
//
// Design choices:
//   1. Flat string-key dictionary (no nesting). Keys group by surface
//      via dot notation (`top.tab.ontology`, `cmd.voice.listening`).
//      Flat keys mean a single object lookup per call — no recursion,
//      no missed-key fallback churn.
//   2. Two languages: `ko` and `en`. Default is `ko` because the
//      operator base is Korean and the original cinematic copy was
//      written in English, so Korean translation is the "added" layer.
//   3. Untranslated technical tokens stay as-is in both languages —
//      JARVIS-flavor acronyms (LIVE, AUTH, ⌘A, SSO, API, KRX, US)
//      read identically in either language and changing them would
//      lose the cyberpunk-cockpit aesthetic.
//   4. Template substitution via `{name}` placeholders. `t(key,
//      { count: 5 })` replaces `{count}` in the value. Missing
//      placeholders pass through verbatim.
//   5. The hook subscribes to a 1Hz storage-event watcher so toggling
//      the language in another tab propagates here too.

import { useEffect, useState, useCallback } from 'react';

export type Language = 'ko' | 'en';

const STORAGE_KEY = 'nexus_os_v1_language_pref';
const DEFAULT_LANG: Language = 'ko';
const SUPPORTED: ReadonlyArray<Language> = ['ko', 'en'];

/* ------------------------------------------------------------------ */
/*  Dictionary — comprehensive coverage of every visible UI string     */
/* ------------------------------------------------------------------ */

/** English source. Korean values come from `KO` below. Key names follow
 *  `<surface>.<sub>.<leaf>` so a search for a substring like `"voice"`
 *  in the dictionary surfaces every related entry. */
const EN: Record<string, string> = {
  // ── TopBar ──────────────────────────────────────────────────────
  'top.subtitle':         'ONTOLOGY OS · v{version}',
  'top.tab.ontology':     '▾ ONTOLOGY',
  'top.tab.snapshots':    '◇ SNAPSHOTS',
  'top.tab.investigations': '≡ INVESTIGATIONS',
  'top.tab.actions':      '⌘ ACTIONS',
  'top.tab.assistant':    '▣ ASSISTANT',
  'top.lang.toggleLabel': 'Language',
  'top.conn.live':        'LIVE',
  'top.conn.auth':        'AUTH',
  'top.conn.link':        'LINK',
  'top.conn.retry':       'RETRY',
  'top.conn.failed':      'FAILED',
  'top.conn.off':         'OFF',
  'top.conn.replay':      'REPLAY',
  'top.conn.title':       'Transport: {state}',
  'top.source.prefix':    'SRC',
  'top.source.title':     'Data source: {label}{suffix}',
  'top.source.suffixRemote': ' (nexus-backend WebSocket)',
  'top.source.suffixLocal':  ' (in-process)',
  'top.api':              'API · {feed}',
  'top.api.pktsPerSec':   '{rate} pkt/s',
  'top.api.latency':      '{latency}ms',
  'top.sso.verified':     'SSO · VERIFIED',
  'top.sso.invalid':      'SSO · INVALID',
  'top.sso.title':        '{protocol} · Session active · expires {expires}',

  // ── CommandCenter ───────────────────────────────────────────────
  'cmd.title':            'COMMAND',
  'cmd.system':           'SYSTEM',
  'cmd.status.listening': 'LISTENING',
  'cmd.status.standby':   'STANDBY',
  'cmd.status.offline':   'OFFLINE',
  'cmd.ready':            'READY',
  'cmd.nav':              'NAV',
  'cmd.nav.actions':      '⌘ ACTIONS · command palette',
  'cmd.nav.assistant':    '▣ ASSISTANT · bilingual chat',
  'cmd.nav.snapshots':    '◇ SNAPSHOTS · capture history',
  'cmd.nav.investigations': '≡ INVESTIGATIONS · watchlist',
  'cmd.voice':            'VOICE',
  'cmd.voice.on':         '● ON',
  'cmd.voice.off':        '○ OFF',
  'cmd.voice.unsupported': 'UNSUPPORTED',
  'cmd.voice.titleOn':    'Voice ON — say analyze / snapshot / isolate / 분석 / 스냅샷 / 격리 …',
  'cmd.voice.titleOff':   'Click to enable voice command',
  'cmd.voice.awaiting':   'AWAITING COMMAND · ⌘ + A/I/T/L/R/S TO INVOKE',
  'cmd.voice.listening':  'LISTENING · SAY "ANALYZE" / "SNAPSHOT" / "분석" / "스냅샷"',
  'cmd.voice.heard':      'HEARD: "{phrase}" → {cmd}',
  'cmd.voice.err.notAllowed':    'MIC BLOCKED · ALLOW IN BROWSER SETTINGS',
  'cmd.voice.err.noMic':         'NO MIC DETECTED · CHECK INPUT DEVICE',
  'cmd.voice.err.unsupported':   'BROWSER UNSUPPORTED · USE CHROME / EDGE',
  'cmd.voice.err.permission':    'MIC PERMISSION DENIED',
  'cmd.voice.err.generic':       'VOICE ERROR · {code}',
  'cmd.footer.operator':  'OPERATOR · {name} · CLEARANCE {clearance}',

  // ── TopBarOverlay (4 tab surfaces) ──────────────────────────────
  'overlay.aria':         '{tab} surface',
  'overlay.escClose':     'ESC TO CLOSE',
  'overlay.snapshots.title':    '◇ SNAPSHOTS · CAPTURED HISTORY',
  'overlay.snapshots.subtitle': '{count} CAPTURE{plural} · {esc}',
  'overlay.snapshots.empty':    '— no snapshots captured yet —',
  'overlay.snapshots.emptyHint': 'Press ⌘S or click "Capture snapshot" in the Command Center.',
  'overlay.snapshots.rowSummary': '{ts} · {nodes} NODES · {bytes}',
  'overlay.snapshots.redownload': '↓ RE-DL',
  'overlay.snapshots.redownloadTitle': 'Re-download original snapshot JSON',
  'overlay.invest.title':       '≡ INVESTIGATIONS · ANOMALY WATCHLIST',
  'overlay.invest.subtitle':    '{count} FLAGGED · ANOMALY ≥ {threshold}% · {esc}',
  'overlay.invest.empty':       '— quiet board —',
  'overlay.invest.emptyHint':   'No entities above {threshold} anomaly threshold.',
  'overlay.invest.rowTitle':    'Click to focus on canvas + open audit modal',
  'overlay.actions.title':      '⌘ ACTIONS · COMMAND PALETTE',
  'overlay.actions.subtitle':   '{count} COMMANDS · {esc}',
  'overlay.actions.analyze':    'Analyze cluster',
  'overlay.actions.snapshot':   'Capture snapshot',
  'overlay.actions.isolate':    'Isolate entity',
  'overlay.actions.trace':      'Trace flow path',
  'overlay.actions.audit':      'Audit transactions',
  'overlay.actions.replay':     'Replay last shock',
  'overlay.actions.alert':      'Raise alert',
  'overlay.actions.tour':       'Show help / tour',
  'overlay.actions.hint.analyze':  "Zoom + pan to the selected entity's cluster",
  'overlay.actions.hint.snapshot': 'Download current dataset JSON + flash canvas',
  'overlay.actions.hint.isolate':  'Dim everything except selected + 1-hop neighbors',
  'overlay.actions.hint.trace':    'Forward BFS along edges, 4 hops downstream',
  'overlay.actions.hint.audit':    'Open audit modal with auto-refresh polling 3s',
  'overlay.actions.hint.replay':   'Re-fire triggerAnomaly on the most recent target',
  'overlay.actions.hint.alert':    'Fire a 4-hop cascading shock animation',
  'overlay.actions.hint.tour':     'Re-run the boot sequence walkthrough',
  'overlay.asst.title':         '▣ NEXUS · ASSISTANT',
  'overlay.asst.subtitle':      'BILINGUAL · TYPE OR ⌘ENTER · {esc}',
  'overlay.asst.placeholder':   'Ask about an entity (e.g. "AAPL", "OBSIDIAN") or a command…',
  'overlay.asst.send':          'SEND ↵',
  'overlay.asst.clear':         'CLEAR',
  'overlay.asst.clearTitle':    'Clear conversation history',
  'overlay.asst.thinking':      '▮ thinking…',
  'overlay.asst.role.op':       'OP',
  'overlay.asst.role.asst':     'ASST',
  'overlay.asst.role.sys':      'SYS',

  // ── HUD panels ──────────────────────────────────────────────────
  'hud.audit.title':            'AUDIT · {symbol}',
  'hud.audit.fetching':         'FETCHING AUDIT TRAIL',
  'hud.audit.empty':            'NO DECISIONS LOGGED',
  'hud.audit.retry':            'RETRY',
  'hud.audit.live':             '◉ LIVE',
  'hud.audit.paused':           'PAUSED',
  'hud.audit.poll3s':           'POLLING 3s',
  'hud.audit.updated.now':      'UPDATED JUST NOW',
  'hud.audit.updated.s':        'UPDATED {n}s AGO',
  'hud.audit.updated.m':        'UPDATED {n}m AGO',
  'hud.prop.title':             'PROPERTIES',
  'hud.prop.id':                'ID',
  'hud.prop.anomalyLive':       'ANOMALY · LIVE',
  'hud.prop.priceLive':         'PRICE · LIVE',
  'hud.prop.acquiringTape':     '— acquiring tape —',
  'hud.prop.signal':            'SIGNAL · {n} DECISIONS',
  'hud.prop.anomaly':           'ANOMALY',
  'hud.prop.volume':            'VOLUME',
  'hud.prop.eigen':             'EIGEN',
  'hud.prop.degree':            'DEGREE',
  'hud.prop.inbound':           'INBOUND',
  'hud.prop.outbound':          'OUTBOUND',
  'hud.prop.aiBadge':           'AI · DERIVED · CONFIDENCE {pct}%',
  'hud.kis.header':             'KIS LIVE',
  'hud.kis.subheader':          '12 SYMS · 2s',
  'hud.tape.live':              'TAPE · LIVE',
  'hud.tape.paused':            'TAPE · PAUSED',
  'hud.tape.resume':            '▶ RESUME',
  'hud.tape.pause':             '❚❚ PAUSE',
  'hud.tape.empty':             '— no ticks recorded yet —',
  'hud.tape.titleResume':       'Resume tape (1s polling)',
  'hud.tape.titlePause':        'Pause tape (DB still records)',
  'hud.vol.title':              'VOLUME · 60M',
  'hud.vol.empty':              '— no volume yet —',
  'hud.health.title':           'SYSTEM HEALTH',
  'hud.health.alive':           'SYSTEM · ALIVE',
  'hud.health.stalled':         'SYSTEM · STALLED',
  'hud.health.pending':         'SYSTEM · PENDING',
  'hud.health.age.now':         'JUST NOW',
  'hud.health.age.s':           '{n}s AGO',
  'hud.health.age.m':           '{n}m AGO',
  'hud.health.age.stalledm':    'STALLED {n}m',
  'hud.health.decMin':          'DEC/MIN',
  'hud.health.noop':            'NOOP',
  'hud.health.blk':             'BLK',
  'hud.health.fill':            'FILL',
  'hud.health.rate30m':         'RATE · 30M',
  'hud.health.maxN':            'MAX {n}/MIN',
  'hud.health.blockedTitle':    'BLOCKED REASONS · 60M',
  'hud.canvas.title':           'ONTOLOGY · GLOBAL MACRO',
  'hud.canvas.summary':         '{ents} ENTITIES · {edges} EDGES · {clusters} CLUSTERS · LIVE',
  'hud.canvas.radar':           'RADAR SCAN ACTIVE',
  'hud.canvas.anomalyEdges':    '◆ {n} ANOMALY EDGES',

  // ── HarnessPanel (NexusTestbed) ─────────────────────────────────
  'harness.title':              '◆ HARNESS · DATA INJECTION',
  'harness.fps':                '{n} FPS',
  'harness.source':             'SOURCE',
  'harness.frequency':          'FREQUENCY',
  'harness.freqUnit':           '{n} pkt/s',
  'harness.shock':              '▲ Simulate Market Shock · {target}',
  'harness.source.backendDesc': 'WS → ws://localhost:8001/v1/stream · nexus-backend publishes real KRX (KIS WS + Yahoo .KS fallback) + US (Yahoo) ticks. Production path.',
  'harness.source.offlineDesc': 'Synthetic random walk (canvas-alive when backend unreachable). Slide to {max} pkt/s to stress the canvas.',
  'harness.source.backend':     'BACKEND · LIVE  ▴KRX+US',
  'harness.source.offline':     'OFFLINE · SIM',

  // ── Boot sequence ───────────────────────────────────────────────
  'boot.l0':  '[ SYSTEM BOOT COMPLETED ]',
  'boot.l1':  '> PRESS [ ⌘S ] TO CAPTURE STATE',
  'boot.l2':  '> DROP .json TO ENTER TIME-MACHINE REPLAY',
  'boot.l3':  '> HOLD [ SHIFT ] + DROP FOR DELTA DIFF',
  'boot.l4':  '> PRESS [ ⌘\\ ] FOR DEEP FOCUS MODE',
  'boot.l5':  '> PRESS [ ? ] OR [ ⌘/ ] TO REOPEN THIS BRIEFING',
};

/** Korean translations. Keys MUST match EN; missing keys fall back to
 *  the EN string (so a partial rollout still renders something). */
const KO: Record<string, string> = {
  // TopBar
  'top.subtitle':         '온톨로지 OS · v{version}',
  'top.tab.ontology':     '▾ 온톨로지',
  'top.tab.snapshots':    '◇ 스냅샷',
  'top.tab.investigations': '≡ 조사',
  'top.tab.actions':      '⌘ 액션',
  'top.tab.assistant':    '▣ 어시스턴트',
  'top.lang.toggleLabel': '언어',
  'top.conn.live':        '라이브',
  'top.conn.auth':        '인증중',
  'top.conn.link':        '연결중',
  'top.conn.retry':       '재시도',
  'top.conn.failed':      '실패',
  'top.conn.off':         '오프',
  'top.conn.replay':      '리플레이',
  'top.conn.title':       '전송 상태: {state}',
  'top.source.prefix':    '소스',
  'top.source.title':     '데이터 소스: {label}{suffix}',
  'top.source.suffixRemote': ' (nexus-backend WebSocket)',
  'top.source.suffixLocal':  ' (인프로세스)',
  'top.api':              'API · {feed}',
  'top.api.pktsPerSec':   '{rate} pkt/s',
  'top.api.latency':      '{latency}ms',
  'top.sso.verified':     'SSO · 인증됨',
  'top.sso.invalid':      'SSO · 무효',
  'top.sso.title':        '{protocol} · 세션 활성 · {expires} 후 만료',

  // CommandCenter
  'cmd.title':            '명령',
  'cmd.system':           '시스템',
  'cmd.status.listening': '청취 중',
  'cmd.status.standby':   '대기',
  'cmd.status.offline':   '오프라인',
  'cmd.ready':            '준비',
  'cmd.nav':              '내비',
  'cmd.nav.actions':      '⌘ 액션 · 명령 팔레트',
  'cmd.nav.assistant':    '▣ 어시스턴트 · 이중언어 채팅',
  'cmd.nav.snapshots':    '◇ 스냅샷 · 캡처 이력',
  'cmd.nav.investigations': '≡ 조사 · 감시 목록',
  'cmd.voice':            '음성',
  'cmd.voice.on':         '● 켜짐',
  'cmd.voice.off':        '○ 꺼짐',
  'cmd.voice.unsupported': '미지원',
  'cmd.voice.titleOn':    '음성 ON — "분석" / "스냅샷" / "격리" / analyze / snapshot / isolate …',
  'cmd.voice.titleOff':   '클릭하여 음성 명령 활성화',
  'cmd.voice.awaiting':   '명령 대기 · ⌘ + A/I/T/L/R/S 호출',
  'cmd.voice.listening':  '듣는 중 · "분석" / "스냅샷" / "ANALYZE" / "SNAPSHOT" 말하세요',
  'cmd.voice.heard':      '인식: "{phrase}" → {cmd}',
  'cmd.voice.err.notAllowed':    '마이크 차단됨 · 브라우저 설정에서 허용',
  'cmd.voice.err.noMic':         '마이크 미감지 · 입력 장치 확인',
  'cmd.voice.err.unsupported':   '브라우저 미지원 · Chrome / Edge 사용',
  'cmd.voice.err.permission':    '마이크 권한 거부',
  'cmd.voice.err.generic':       '음성 오류 · {code}',
  'cmd.footer.operator':  '운영자 · {name} · 권한 {clearance}',

  // TopBarOverlay
  'overlay.aria':         '{tab} 화면',
  'overlay.escClose':     'ESC로 닫기',
  'overlay.snapshots.title':    '◇ 스냅샷 · 캡처 이력',
  'overlay.snapshots.subtitle': '{count}건 캡처 · {esc}',
  'overlay.snapshots.empty':    '— 아직 캡처된 스냅샷 없음 —',
  'overlay.snapshots.emptyHint': '⌘S를 누르거나 Command Center에서 "Capture snapshot" 클릭.',
  'overlay.snapshots.rowSummary': '{ts} · 노드 {nodes}개 · {bytes}',
  'overlay.snapshots.redownload': '↓ 다운로드',
  'overlay.snapshots.redownloadTitle': '원본 스냅샷 JSON 재다운로드',
  'overlay.invest.title':       '≡ 조사 · 이상 감시 목록',
  'overlay.invest.subtitle':    '{count}건 플래그 · 이상도 ≥ {threshold}% · {esc}',
  'overlay.invest.empty':       '— 조용한 보드 —',
  'overlay.invest.emptyHint':   '이상도 {threshold} 이상인 엔티티 없음.',
  'overlay.invest.rowTitle':    '클릭하여 캔버스 포커스 + audit modal 열기',
  'overlay.actions.title':      '⌘ 액션 · 명령 팔레트',
  'overlay.actions.subtitle':   '{count}개 명령 · {esc}',
  'overlay.actions.analyze':    '클러스터 분석',
  'overlay.actions.snapshot':   '스냅샷 캡처',
  'overlay.actions.isolate':    '엔티티 격리',
  'overlay.actions.trace':      '흐름 경로 추적',
  'overlay.actions.audit':      '트랜잭션 감사',
  'overlay.actions.replay':     '마지막 쇼크 재생',
  'overlay.actions.alert':      '경보 발령',
  'overlay.actions.tour':       '도움말 / 튜토리얼',
  'overlay.actions.hint.analyze':  '선택 엔티티의 클러스터로 줌 + 팬',
  'overlay.actions.hint.snapshot': '현재 dataset JSON 다운로드 + 캔버스 플래시',
  'overlay.actions.hint.isolate':  '선택 + 1-hop 이웃만 강조, 나머지 dim',
  'overlay.actions.hint.trace':    '엣지 따라 forward BFS, 4-hop 다운스트림',
  'overlay.actions.hint.audit':    'audit modal 열기, 3초 자동 새로고침',
  'overlay.actions.hint.replay':   '최근 대상에 triggerAnomaly 재발화',
  'overlay.actions.hint.alert':    '4-hop 캐스케이딩 쇼크 애니메이션',
  'overlay.actions.hint.tour':     '부팅 시퀀스 안내 다시 보기',
  'overlay.asst.title':         '▣ NEXUS · 어시스턴트',
  'overlay.asst.subtitle':      '이중언어 · 입력 또는 ⌘Enter · {esc}',
  'overlay.asst.placeholder':   '엔티티 (예: "AAPL", "OBSIDIAN") 또는 명령을 입력하세요…',
  'overlay.asst.send':          '전송 ↵',
  'overlay.asst.clear':         '지우기',
  'overlay.asst.clearTitle':    '대화 기록 삭제',
  'overlay.asst.thinking':      '▮ 생각 중…',
  'overlay.asst.role.op':       '운영자',
  'overlay.asst.role.asst':     'AI',
  'overlay.asst.role.sys':      '시스템',

  // HUD panels
  'hud.audit.title':            '감사 · {symbol}',
  'hud.audit.fetching':         '감사 추적 가져오는 중',
  'hud.audit.empty':            '기록된 의사결정 없음',
  'hud.audit.retry':            '재시도',
  'hud.audit.live':             '◉ 라이브',
  'hud.audit.paused':           '일시정지',
  'hud.audit.poll3s':           '3초마다 폴링',
  'hud.audit.updated.now':      '방금 업데이트',
  'hud.audit.updated.s':        '{n}초 전 업데이트',
  'hud.audit.updated.m':        '{n}분 전 업데이트',
  'hud.prop.title':             '속성',
  'hud.prop.id':                'ID',
  'hud.prop.anomalyLive':       '이상 · 라이브',
  'hud.prop.priceLive':         '가격 · 라이브',
  'hud.prop.acquiringTape':     '— 테이프 수집 중 —',
  'hud.prop.signal':            '신호 · {n}건 의사결정',
  'hud.prop.anomaly':           '이상도',
  'hud.prop.volume':            '거래량',
  'hud.prop.eigen':             '고유',
  'hud.prop.degree':            '연결도',
  'hud.prop.inbound':           '인바운드',
  'hud.prop.outbound':          '아웃바운드',
  'hud.prop.aiBadge':           'AI · 도출 · 신뢰도 {pct}%',
  'hud.kis.header':             'KIS 라이브',
  'hud.kis.subheader':          '12종목 · 2초',
  'hud.tape.live':              '테이프 · 라이브',
  'hud.tape.paused':            '테이프 · 일시정지',
  'hud.tape.resume':            '▶ 재개',
  'hud.tape.pause':             '❚❚ 일시정지',
  'hud.tape.empty':             '— 아직 기록된 체결 없음 —',
  'hud.tape.titleResume':       '테이프 재개 (1초 폴링)',
  'hud.tape.titlePause':        '테이프 일시정지 (DB는 계속 기록)',
  'hud.vol.title':              '거래량 · 60분',
  'hud.vol.empty':              '— 거래량 없음 —',
  'hud.health.title':           '시스템 상태',
  'hud.health.alive':           '시스템 · 활성',
  'hud.health.stalled':         '시스템 · 지연',
  'hud.health.pending':         '시스템 · 대기',
  'hud.health.age.now':         '방금',
  'hud.health.age.s':           '{n}초 전',
  'hud.health.age.m':           '{n}분 전',
  'hud.health.age.stalledm':    '지연 {n}분',
  'hud.health.decMin':          '결정/분',
  'hud.health.noop':            '무동작',
  'hud.health.blk':             '차단',
  'hud.health.fill':            '체결',
  'hud.health.rate30m':         '속도 · 30분',
  'hud.health.maxN':            '최대 {n}/분',
  'hud.health.blockedTitle':    '차단 사유 · 60분',
  'hud.canvas.title':           '온톨로지 · GLOBAL MACRO',
  'hud.canvas.summary':         '엔티티 {ents} · 엣지 {edges} · 클러스터 {clusters} · 라이브',
  'hud.canvas.radar':           '레이더 스캔 활성',
  'hud.canvas.anomalyEdges':    '◆ 이상 엣지 {n}',

  // HarnessPanel
  'harness.title':              '◆ HARNESS · 데이터 주입',
  'harness.fps':                '{n} FPS',
  'harness.source':             '소스',
  'harness.frequency':          '주파수',
  'harness.freqUnit':           '초당 {n} 패킷',
  'harness.shock':              '▲ 시장 충격 시뮬레이트 · {target}',
  'harness.source.backendDesc': 'WS → ws://localhost:8001/v1/stream · nexus-backend가 실 KRX (KIS WS + Yahoo .KS fallback) + US (Yahoo) 틱 발행. 프로덕션 경로.',
  'harness.source.offlineDesc': '합성 랜덤 워크 (백엔드 도달 불가 시 캔버스 유지). {max} pkt/s까지 슬라이드하여 캔버스 부하 테스트.',
  'harness.source.backend':     'BACKEND · LIVE  ▴KRX+US',
  'harness.source.offline':     'OFFLINE · SIM',

  // Boot sequence
  'boot.l0':  '[ 시스템 부팅 완료 ]',
  'boot.l1':  '> [ ⌘S ]로 상태 캡처',
  'boot.l2':  '> .json 드롭하여 타임머신 재생 진입',
  'boot.l3':  '> [ SHIFT ] + 드롭하여 델타 diff',
  'boot.l4':  '> [ ⌘\\ ]로 딥 포커스 모드',
  'boot.l5':  '> [ ? ] 또는 [ ⌘/ ]로 이 안내 다시 열기',
};

const DICT: Record<Language, Record<string, string>> = { en: EN, ko: KO };

/* ------------------------------------------------------------------ */
/*  Persistence + change events                                        */
/* ------------------------------------------------------------------ */

function loadLanguagePref(): Language {
  try {
    if (typeof window === 'undefined') return DEFAULT_LANG;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && (SUPPORTED as ReadonlyArray<string>).includes(raw)) {
      return raw as Language;
    }
  } catch { /* storage disabled */ }
  return DEFAULT_LANG;
}

function saveLanguagePref(lang: Language): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, lang);
    // Fire a custom event so other useLanguage instances in the same
    // tab re-render. The native 'storage' event only fires CROSS-tab.
    window.dispatchEvent(new CustomEvent('nexus-lang-change', { detail: lang }));
  } catch { /* swallow */ }
}

/* ------------------------------------------------------------------ */
/*  Substitution                                                       */
/* ------------------------------------------------------------------ */

/** Replace `{name}` placeholders in `template` with values from `params`.
 *  Missing keys pass through verbatim (`{count}` stays literal) so a
 *  forgotten param is loud, not silent. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = params[key];
    return v === undefined ? m : String(v);
  });
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export interface UseLanguageApi {
  lang: Language;
  setLang: (lang: Language) => void;
  /** Translate a key. Falls back to EN, then the raw key, on miss. */
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function useLanguage(): UseLanguageApi {
  const [lang, setLangState] = useState<Language>(() => loadLanguagePref());

  // Subscribe to same-tab + cross-tab language changes. Same-tab uses
  // our custom event (saveLanguagePref dispatches it); cross-tab uses
  // the browser's storage event so a toggle in another tab also moves
  // this one.
  useEffect(() => {
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<Language>).detail;
      if (detail === 'en' || detail === 'ko') setLangState(detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        if (e.newValue === 'en' || e.newValue === 'ko') setLangState(e.newValue);
      }
    };
    window.addEventListener('nexus-lang-change', onCustom as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('nexus-lang-change', onCustom as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
    saveLanguagePref(next);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const dict = DICT[lang];
      const template = dict[key] ?? EN[key] ?? key;
      return interpolate(template, params);
    },
    [lang],
  );

  return { lang, setLang, t };
}
